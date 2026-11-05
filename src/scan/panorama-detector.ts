/**
 * Panorama candidates in a library scan.
 *
 * Two stages, after Hugin's "search for panoramas" (photos from the same camera, taken
 * moments apart) and graph-based panorama recognition (Brown & Lowe):
 *   1. TimeSequenceGrouper: runs of same-size photos taken within seconds of each other;
 *   2. an OverlapChecker (the stitching engine) keeps only photos that make a panorama: a
 *      burst of one view also matches, so it must extend the view and stitch believably.
 * Only photos that end up in a stitched preview are ever shown.
 */

import type { LibraryItem } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";
import type { ScanCache } from "./scan-cache.js";
import type { DetectorStats, ScanContext, ScanDetector, ScanFinding } from "./scan-detector.js";

export interface SequenceOptions {
  /** Largest gap between consecutive shots of one panorama. */
  maxGapMs: number;
  minPhotos: number;
  maxPhotos: number;
  /** Photos wider than this (long side / short side) are already panoramas. */
  maxAspect: number;
}

export class TimeSequenceGrouper {
  static readonly DEFAULTS: SequenceOptions = { maxGapMs: 30_000, minPhotos: 2, maxPhotos: 40, maxAspect: 2.2 };

  /** Runs of consecutive same-size photos taken close together, oldest first. */
  static group(items: readonly LibraryItem[], options: SequenceOptions = TimeSequenceGrouper.DEFAULTS): LibraryItem[][] {
    // Paragraph: photos only, in capture order.
    const photos = items
      .filter((i) => i.type === "photo" && i.width > 0 && i.height > 0 && Math.max(i.width, i.height) / Math.min(i.width, i.height) <= options.maxAspect)
      .sort((a, b) => a.takenAtMs - b.takenAtMs);

    // Paragraph: break wherever the gap is too long or the camera/size changes.
    const runs: LibraryItem[][] = [];
    let run: LibraryItem[] = [];
    for (const p of photos) {
      const prev = run[run.length - 1];
      if (prev && (p.takenAtMs - prev.takenAtMs > options.maxGapMs || !TimeSequenceGrouper.sameSize(prev, p))) {
        runs.push(run);
        run = [];
      }
      run.push(p);
    }
    if (run.length > 0) runs.push(run);

    // Paragraph: too-long runs are split at their largest gaps.
    return runs.flatMap((r) => TimeSequenceGrouper.split(r, options.maxPhotos)).filter((r) => r.length >= options.minPhotos);
  }

  private static sameSize(a: LibraryItem, b: LibraryItem): boolean {
    return (a.width === b.width && a.height === b.height) || (a.width === b.height && a.height === b.width);
  }

  private static split(run: LibraryItem[], max: number): LibraryItem[][] {
    if (run.length <= max) return [run];
    let cut = 1;
    for (let i = 1; i < run.length; i++) {
      if (run[i]!.takenAtMs - run[i - 1]!.takenAtMs > run[cut]!.takenAtMs - run[cut - 1]!.takenAtMs) cut = i;
    }
    return [...TimeSequenceGrouper.split(run.slice(0, cut), max), ...TimeSequenceGrouper.split(run.slice(cut), max)];
  }
}

/** A quick stitch of a candidate, made from thumbnails. */
export interface CandidatePreview {
  image: Blob;
  width: number;
  height: number;
  /** Camera motion the preview stitched with ("rotate" first, "flat" if that was not believable). */
  motion: "rotate" | "flat";
}

/**
 * Whether a stitched output is a panorama. The turning-in-place model stretches bursts into
 * long strips, so the output must show clearly more than one photo, yet no more than its photos can.
 * Measured on 468 real sequences and OpenCV's public samples (ADR-0006).
 */
export class PanoramaPlausibility {
  static readonly MIN_VIEW_GAIN = 1.25;
  static readonly MAX_GAIN_PER_PHOTO = 1.15;
  static readonly MIN_SHORT_SIDE = 0.5;

  static holds(output: { viewGain: number; shortSide: number; used: readonly unknown[] }): boolean {
    return output.used.length >= 2
      && output.viewGain >= PanoramaPlausibility.MIN_VIEW_GAIN
      && output.viewGain <= output.used.length * PanoramaPlausibility.MAX_GAIN_PER_PHOTO
      && output.shortSide >= PanoramaPlausibility.MIN_SHORT_SIDE;
  }
}

export interface OverlapGroup {
  /** The photos that made it into the preview. */
  mediaKeys: string[];
  preview: CandidatePreview;
  /** Small images of those photos, by media key. */
  thumbs: Record<string, Blob>;
}

/** A saved sequence result. Uses dedup keys: album listings give the same photos other media keys. */
export interface SavedSequence {
  groups: { photos: string[]; preview: CandidatePreview; thumbs: Record<string, Blob> }[];
}

/** Decides which photos of a time sequence overlap (and previews each group). */
export interface OverlapChecker {
  /** `onProgress` receives how far along this sequence is (0..1). */
  check(sequence: readonly LibraryItem[], signal: AbortSignal, onProgress: (fraction: number) => void): Promise<OverlapGroup[]>;
}

export interface PanoramaCandidate extends ScanFinding {
  detector: "panorama";
  items: LibraryItem[];
  preview: CandidatePreview;
  thumbs: Record<string, Blob>;
  /** A panorama Pixlixir already saved from (most of) these photos. */
  alreadyMade: { webUrl: string } | null;
}

export class PanoramaDetector implements ScanDetector<PanoramaCandidate> {
  readonly id = "panorama" as const;
  readonly label = "Panoramas";
  readonly description = "Overlapping photos taken seconds apart, ready to stitch.";

  /** Bump when detection changes, so results saved by older versions are checked again. */
  static readonly RESULT_VERSION = 2;
  /** This many failures in a row means something systemic: stop instead of failing on every sequence. */
  static readonly MAX_FAILURES_IN_A_ROW = 5;

  constructor(
    private readonly checker: OverlapChecker,
    /** Gets the group's items (album listings use album-specific keys; dedup keys are stable everywhere). */
    private readonly alreadyMade: (items: readonly LibraryItem[]) => { webUrl: string } | null,
    private readonly cache: ScanCache<SavedSequence>,
    /** Ignore saved results and check every photo again. */
    private readonly recheck: boolean = false,
    private readonly options: SequenceOptions = TimeSequenceGrouper.DEFAULTS,
  ) {}

  static signature(sequence: readonly LibraryItem[]): string {
    return `v${PanoramaDetector.RESULT_VERSION}|${sequence.map((i) => i.dedupKey).join(",")}`;
  }

  async analyze(items: readonly LibraryItem[], ctx: ScanContext, emit: (finding: PanoramaCandidate) => void): Promise<DetectorStats> {
    // Paragraph: cheap pre-filter on capture times.
    const sequences = TimeSequenceGrouper.group(items, this.options);
    const byKey = new Map(items.map((i) => [i.mediaKey, i]));
    const stats: DetectorStats = { photosReused: 0, photosChecked: 0, failures: [] };

    // Paragraph: saved results first, so earlier findings appear at once and progress only counts new work.
    const pending: LibraryItem[][] = [];
    for (const [n, sequence] of sequences.entries()) {
      ctx.progress("Reading saved results", n, sequences.length);
      const saved = this.recheck ? null : await this.cache.get(PanoramaDetector.signature(sequence));
      if (!saved) {
        pending.push(sequence);
        continue;
      }
      stats.photosReused += sequence.length;
      for (const g of PanoramaDetector.fromSaved(saved, sequence)) this.emitGroup(g, byKey, emit);
    }

    // Paragraph: check the rest with the stitching engine; progress counts photos, not sequences.
    const total = pending.reduce((n, s) => n + s.length, 0);
    let inARow = 0;
    for (const sequence of pending) {
      const start = stats.photosChecked;
      ctx.progress("Checking new photos", start, total);
      try {
        const groups = await this.checker.check(sequence, ctx.signal, (f) => ctx.progress("Checking new photos", start + Math.floor(f * sequence.length), total));
        for (const g of groups) this.emitGroup(g, byKey, emit);
        await this.cache.put(PanoramaDetector.signature(sequence), PanoramaDetector.toSaved(groups, byKey));
        inARow = 0;
      } catch (err) {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.StitchFailed, "Could not check a sequence of photos");
        if (PanoramaDetector.stopsTheScan(e) || ++inARow >= PanoramaDetector.MAX_FAILURES_IN_A_ROW) throw e;
        stats.failures.push(e.toJSON());
      }
      stats.photosChecked += sequence.length;
    }
    ctx.progress("Checking new photos", total, total);
    return stats;
  }

  private emitGroup(g: OverlapGroup, byKey: Map<string, LibraryItem>, emit: (finding: PanoramaCandidate) => void): void {
    const keys = g.mediaKeys;
    const groupItems = keys.map((k) => byKey.get(k)!);
    emit({
      id: `panorama:${keys[0]}:${keys.length}`,
      detector: "panorama",
      mediaKeys: keys,
      items: groupItems,
      preview: g.preview,
      thumbs: g.thumbs,
      alreadyMade: this.alreadyMade(groupItems),
    });
  }

  private static toSaved(groups: readonly OverlapGroup[], byKey: Map<string, LibraryItem>): SavedSequence {
    const dedup = (k: string) => byKey.get(k)!.dedupKey;
    return {
      groups: groups.map((g) => ({
        photos: g.mediaKeys.map(dedup),
        preview: g.preview,
        thumbs: Object.fromEntries(Object.entries(g.thumbs).map(([k, blob]) => [dedup(k), blob])),
      })),
    };
  }

  /** Maps saved dedup keys back to this listing's media keys (same signature, so all are present). */
  private static fromSaved(saved: SavedSequence, sequence: readonly LibraryItem[]): OverlapGroup[] {
    const media = new Map(sequence.map((i) => [i.dedupKey, i.mediaKey]));
    const key = (d: string) => media.get(d)!;
    return saved.groups.map((g) => ({
      mediaKeys: g.photos.map(key),
      preview: g.preview,
      thumbs: Object.fromEntries(Object.entries(g.thumbs).map(([d, blob]) => [key(d), blob])),
    }));
  }

  /** Problems that would hit every sequence, and the user stopping the scan. */
  private static stopsTheScan(e: PixError): boolean {
    return e.code === ErrorCode.Cancelled || e.code === ErrorCode.AccountMismatch || e.code === ErrorCode.TabNotBound || e.code === ErrorCode.SessionUnavailable || e.code === ErrorCode.RuntimeUnavailable || e.code === ErrorCode.StorageFailed;
  }
}
