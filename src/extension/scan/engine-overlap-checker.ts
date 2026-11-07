/**
 * OverlapChecker backed by the panorama engine: loads thumbnails of a time sequence,
 * asks the engine which photos overlap, and stitches a quick preview of each group.
 */

import type { LimitFunction } from "p-limit";
import type { LibraryItem } from "../../domain/types.js";
import { DEFAULT_STITCH_SETTINGS, type Motion } from "../../imaging/panorama/stitch-runtime.js";
import { PanoramaPlausibility, type CandidatePreview, type OverlapChecker, type OverlapGroup } from "../../scan/panorama-detector.js";
import { ScanFailures } from "../../scan/scan-detector.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import type { PanoramaWorkerClient } from "../editor/panorama/panorama-client.js";
import type { PhotosGateway } from "../editor/photos-gateway.js";

export class EngineOverlapChecker implements OverlapChecker {
  /** Long side of the thumbnails used for detection and previews. */
  static readonly THUMB_SIDE = 800;
  /** At once, across all engines of a scan (Google's servers see the sum). */
  static readonly PARALLEL_DOWNLOADS = 8;

  constructor(
    private readonly gateway: PhotosGateway,
    private readonly worker: PanoramaWorkerClient,
    /** Shared by the scan's checkers. */
    private readonly downloads: LimitFunction,
    private readonly nextKey: () => number,
    /** Makes the small image kept for each photo that ends up in a group. */
    private readonly shrink: (thumb: Blob) => Promise<Blob>,
  ) {}

  async check(sequence: readonly LibraryItem[], signal: AbortSignal, onProgress: (fraction: number) => void, onLeftOut: (error: SerializedError) => void = () => {}): Promise<OverlapGroup[]> {
    const keys = new Map<number, LibraryItem>();
    const thumbs = new Map<string, Blob>();
    try {
      // Paragraph: thumbnails into the engine. All of them settle first, so a failure leaves nothing still loading.
      const loads = await Promise.allSettled(sequence.map(async (item) => {
        const { blob, bitmap } = await this.thumbnail(item, signal);
        thumbs.set(item.mediaKey, blob);
        const key = this.nextKey();
        keys.set(key, item);
        await this.worker.load(key, bitmap);
        onProgress(0.4 * (thumbs.size / sequence.length));
      }));

      // Paragraph: a photo that cannot be read is left out and reported, unless too few are left or the problem would hit everything.
      const failures = loads.flatMap((l) => (l.status === "rejected" ? [l.reason instanceof PixError ? l.reason : PixError.wrap(l.reason, ErrorCode.MediaFetchFailed, "Could not read a photo")] : []));
      const stopping = failures.find((e) => ScanFailures.stopsTheScan(e));
      if (stopping) throw stopping;
      if (failures.length > 0 && keys.size < 2) throw failures[0];
      for (const e of failures) onLeftOut(e.toJSON());

      // Paragraph: which photos overlap (keys in capture order).
      const ordered = [...keys.entries()].sort((a, b) => a[1].takenAtMs - b[1].takenAtMs).map(([k]) => k);
      const found = await this.worker.findGroups(ordered);
      onProgress(0.6);

      // Paragraph: a preview per group.
      const groups: OverlapGroup[] = [];
      for (const [n, g] of found.groups.entries()) {
        if (signal.aborted) throw new PixError(ErrorCode.Cancelled, "The scan was stopped");
        const stitched = await this.preview(g.keys);
        if (stitched) {
          const mediaKeys = stitched.used.map((k) => keys.get(k)!.mediaKey);
          const small: Record<string, Blob> = {};
          for (const mk of mediaKeys) small[mk] = await this.shrink(thumbs.get(mk)!);
          groups.push({ mediaKeys, preview: stitched.preview, thumbs: small });
        }
        onProgress(0.6 + 0.4 * ((n + 1) / found.groups.length));
      }
      return groups;
    } finally {
      // Paragraph: free the engine's copies whatever happened.
      for (const k of keys.keys()) await this.worker.remove(k).catch((e: unknown) => console.error("[pixlixir] could not free a thumbnail", e));
    }
  }

  /** A small image and its decoded form. One bad answer gets a second try, since the same photo usually reads at other sizes. */
  private async thumbnail(item: LibraryItem, signal: AbortSignal): Promise<{ blob: Blob; bitmap: ImageBitmap }> {
    const download = () => this.downloads(() => {
      if (signal.aborted) throw new PixError(ErrorCode.Cancelled, "The scan was stopped");
      return this.gateway.thumbnail(item.baseUrl, EngineOverlapChecker.THUMB_SIDE);
    });
    let blob = await download();
    try {
      return { blob, bitmap: await createImageBitmap(blob) };
    } catch {
      blob = await download();
    }
    try {
      return { blob, bitmap: await createImageBitmap(blob) };
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.MediaDecodeFailed, "A photo could not be read, so it was left out of the panorama check", { mediaKey: item.mediaKey, mimeType: blob.type, bytes: blob.size });
    }
  }

  /**
   * Stitches "turning in place" first, then "moving over a flat surface", and returns the first
   * believable panorama. Null means these photos do not make one, which is an answer rather than
   * a failure; anything else that goes wrong (memory, the engine) propagates and is reported.
   */
  private async preview(groupKeys: number[]): Promise<{ preview: CandidatePreview; used: number[] } | null> {
    for (const motion of ["rotate", "flat"] as Motion[]) {
      try {
        const r = await this.worker.stitch(groupKeys, { ...DEFAULT_STITCH_SETTINGS, motion }, { kind: "preview" });
        if (PanoramaPlausibility.holds(r)) return { preview: { image: r.image, width: r.width, height: r.height, motion }, used: r.used };
      } catch (err) {
        if (!EngineOverlapChecker.doesNotStitch(err)) throw err;
      }
    }
    return null;
  }

  /** The stitcher's own "cannot align these", as opposed to OpenCV or runtime errors. */
  private static doesNotStitch(err: unknown): boolean {
    if (!(err instanceof PixError)) return false;
    return err.code === ErrorCode.StitchNotConnected || (err.code === ErrorCode.StitchFailed && err.details?.reason !== "OPENCV");
  }
}
