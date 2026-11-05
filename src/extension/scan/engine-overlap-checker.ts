/**
 * OverlapChecker backed by the panorama engine: loads thumbnails of a time sequence,
 * asks the engine which photos overlap, and stitches a quick preview of each group.
 */

import type { LibraryItem } from "../../domain/types.js";
import { DEFAULT_STITCH_SETTINGS, type Motion } from "../../imaging/panorama/stitch-runtime.js";
import { PanoramaPlausibility, type CandidatePreview, type OverlapChecker, type OverlapGroup } from "../../scan/panorama-detector.js";
import { ErrorCode, PixError } from "../../shared/errors.js";
import type { PanoramaWorkerClient } from "../editor/panorama/panorama-client.js";
import type { PhotosGateway } from "../editor/photos-gateway.js";

export class EngineOverlapChecker implements OverlapChecker {
  /** Long side of the thumbnails used for detection and previews. */
  static readonly THUMB_SIDE = 800;
  static readonly PARALLEL_DOWNLOADS = 4;

  constructor(
    private readonly gateway: PhotosGateway,
    private readonly worker: PanoramaWorkerClient,
    private readonly nextKey: () => number,
    /** Makes the small image kept for each photo that ends up in a group. */
    private readonly shrink: (thumb: Blob) => Promise<Blob>,
  ) {}

  async check(sequence: readonly LibraryItem[], signal: AbortSignal, onProgress: (fraction: number) => void): Promise<OverlapGroup[]> {
    const keys = new Map<number, LibraryItem>();
    const thumbs = new Map<string, Blob>();
    try {
      // Paragraph: thumbnails into the engine, a few downloads at a time.
      for (let i = 0; i < sequence.length; i += EngineOverlapChecker.PARALLEL_DOWNLOADS) {
        if (signal.aborted) throw new PixError(ErrorCode.Cancelled, "The scan was stopped");
        await Promise.all(sequence.slice(i, i + EngineOverlapChecker.PARALLEL_DOWNLOADS).map(async (item) => {
          const blob = await this.gateway.thumbnail(item.baseUrl, EngineOverlapChecker.THUMB_SIDE);
          thumbs.set(item.mediaKey, blob);
          const bitmap = await createImageBitmap(blob);
          const key = this.nextKey();
          await this.worker.load(key, bitmap);
          keys.set(key, item);
          onProgress(0.4 * (keys.size / sequence.length));
        }));
      }

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
