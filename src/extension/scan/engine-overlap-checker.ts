/**
 * OverlapChecker backed by the panorama engine: loads thumbnails of a time sequence,
 * asks the engine which photos overlap, and stitches a quick preview of each group.
 */

import type { LibraryItem } from "../../domain/types.js";
import { DEFAULT_STITCH_SETTINGS, type Motion } from "../../imaging/panorama/stitch-runtime.js";
import type { CandidatePreview, OverlapChecker, OverlapGroup } from "../../scan/panorama-detector.js";
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
    /** Receives the thumbnail of each photo that ends up in a group (for the scan page). */
    private readonly keepThumbnail: (mediaKey: string, thumb: Blob) => Promise<void>,
  ) {}

  async check(sequence: readonly LibraryItem[], signal: AbortSignal): Promise<OverlapGroup[]> {
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
        }));
      }

      // Paragraph: which photos overlap (keys in capture order).
      const ordered = [...keys.entries()].sort((a, b) => a[1].takenAtMs - b[1].takenAtMs).map(([k]) => k);
      const found = await this.worker.findGroups(ordered);

      // Paragraph: a preview per group.
      const groups: OverlapGroup[] = [];
      for (const g of found.groups) {
        if (signal.aborted) throw new PixError(ErrorCode.Cancelled, "The scan was stopped");
        const mediaKeys = g.keys.map((k) => keys.get(k)!.mediaKey);
        const duplicates = g.duplicates.map((k) => keys.get(k)!.mediaKey);
        for (const mk of [...mediaKeys, ...duplicates]) await this.keepThumbnail(mk, thumbs.get(mk)!);
        try {
          groups.push({ mediaKeys, duplicates, preview: await this.preview(g.keys, keys), previewError: null });
        } catch (err) {
          if (err instanceof PixError && err.code === ErrorCode.Cancelled) throw err;
          const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.StitchFailed, "Preview failed");
          groups.push({ mediaKeys, duplicates, preview: null, previewError: e.toJSON() });
        }
      }
      return groups;
    } finally {
      // Paragraph: free the engine's copies whatever happened.
      for (const k of keys.keys()) await this.worker.remove(k).catch((e: unknown) => console.error("[pixlixir] could not free a thumbnail", e));
    }
  }

  /**
   * Stitches "turning in place" first and, only if that cannot work out the camera
   * positions, "moving over a flat surface" — the result says which one was used.
   */
  private async preview(groupKeys: number[], items: Map<number, LibraryItem>): Promise<CandidatePreview> {
    let lastError: unknown = null;
    for (const motion of ["rotate", "flat"] as Motion[]) {
      try {
        const r = await this.worker.stitch(groupKeys, { ...DEFAULT_STITCH_SETTINGS, motion }, { kind: "preview" });
        return { image: r.image, width: r.width, height: r.height, motion, dropped: r.dropped.map((k) => items.get(k)!.mediaKey) };
      } catch (err) {
        lastError = err;
        if (!(err instanceof PixError) || err.code !== ErrorCode.StitchFailed) throw err; // only alignment-type failures justify the other model
      }
    }
    throw lastError;
  }
}
