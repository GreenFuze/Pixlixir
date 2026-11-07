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
import { ErrorCode, PixError, type SerializedError } from "../shared/errors.js";
import type { ScanCache } from "./scan-cache.js";
import { ScanFailures, type DetectorStats, type ScanContext, type ScanDetector, type ScanFinding } from "./scan-detector.js";

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
  /** `onProgress` receives how far along this sequence is (0..1); `onLeftOut` each photo checked without. */
  check(sequence: readonly LibraryItem[], signal: AbortSignal, onProgress: (fraction: number) => void, onLeftOut?: (error: SerializedError) => void): Promise<OverlapGroup[]>;
}

export interface PanoramaCandidate extends ScanFinding {
  detector: "panorama";
  items: LibraryItem[];
  preview: CandidatePreview;
  thumbs: Record<string, Blob>;
  /** A panorama Pixlixir already saved from half of these photos: more than half hides the group. */
  alreadyMade: AlreadyMade | null;
}

export interface AlreadyMade {
  webUrl: string;
  /** Most of these photos are in it, so showing them again would only repeat it. */
  covers: boolean;
}

/**
 * How many engines a scan runs at once. Each is a whole Python runtime (about 350 MB), so this is
 * bounded by cores and memory. Measured in ADR-0006: 8 engines take a quarter of the time of 1.
 */
export class ScanConcurrency {
  static readonly MAX_ENGINES = 8;

  static engines(cores: number, memoryGb: number | undefined): number {
    const byCores = Math.max(1, Math.floor(cores / 2));
    const byMemory = memoryGb === undefined ? 2 : Math.max(1, Math.floor(memoryGb / 4));
    return Math.min(ScanConcurrency.MAX_ENGINES, byCores, byMemory);
  }
}

export class PanoramaDetector implements ScanDetector<PanoramaCandidate> {
  readonly id = "panorama" as const;
  readonly label = "Panoramas";
  readonly description = "Overlapping photos taken seconds apart, ready to stitch.";

  /** Bump when detection changes, so results saved by older versions are checked again. */
  static readonly RESULT_VERSION = 2;
  /** This many failures in a row means something systemic: stop instead of failing on every sequence. */
  static readonly MAX_FAILURES_IN_A_ROW = 5;

  readonly #checkers: readonly OverlapChecker[];

  constructor(
    /** One per engine: sequences are checked side by side. */
    checkers: OverlapChecker | readonly OverlapChecker[],
    /** Gets the group's items (album listings use album-specific keys; dedup keys are stable everywhere). */
    private readonly alreadyMade: (items: readonly LibraryItem[]) => AlreadyMade | null,
    private readonly cache: ScanCache<SavedSequence>,
    /** Ignore saved results and check every photo again. */
    private readonly recheck: boolean = false,
    private readonly options: SequenceOptions = TimeSequenceGrouper.DEFAULTS,
  ) {
    this.#checkers = [checkers].flat() as OverlapChecker[];
    if (this.#checkers.length === 0) throw new PixError(ErrorCode.Internal, "A panorama scan needs at least one checker");
  }

  static signature(sequence: readonly LibraryItem[]): string {
    return `v${PanoramaDetector.RESULT_VERSION}|${sequence.map((i) => i.dedupKey).join(",")}`;
  }

  async analyze(items: readonly LibraryItem[], ctx: ScanContext, emit: (finding: PanoramaCandidate) => void): Promise<DetectorStats> {
    // Paragraph: cheap pre-filter on capture times.
    const sequences = TimeSequenceGrouper.group(items, this.options);
    const byKey = new Map(items.map((i) => [i.mediaKey, i]));
    const stats: DetectorStats = { photosReused: 0, photosChecked: 0, failures: [] };
    const hidden = { count: 0 };

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
      for (const g of PanoramaDetector.fromSaved(saved, sequence)) this.emitGroup(g, byKey, emit, hidden);
    }

    // Paragraph: check the rest with the stitching engine; progress counts photos, not sequences.
    const total = pending.reduce((n, s) => n + s.length, 0);
    const inProgress = new Map<LibraryItem[], number>();
    const report = () => ctx.progress("Checking new photos", stats.photosChecked + [...inProgress.values()].reduce((a, b) => a + b, 0), total);
    let inARow = 0;
    let next = 0;
    const stop: { error: PixError | null } = { error: null };

    // Paragraph: each engine takes the next sequence when free. Every finished sequence is saved at once.
    const work = async (checker: OverlapChecker) => {
      while (stop.error === null && next < pending.length) {
        const sequence = pending[next++]!;
        inProgress.set(sequence, 0);
        report();
        try {
          const leftOut: SerializedError[] = [];
          const groups = await checker.check(sequence, ctx.signal, (f) => {
            inProgress.set(sequence, Math.floor(f * sequence.length));
            report();
          }, (e) => leftOut.push(e));
          for (const g of groups) this.emitGroup(g, byKey, emit, hidden);
          // A sequence checked without a photo is not saved, so the next scan tries that photo again.
          if (leftOut.length === 0) await this.cache.put(PanoramaDetector.signature(sequence), PanoramaDetector.toSaved(groups, byKey));
          stats.failures.push(...leftOut);
          inARow = 0;
        } catch (err) {
          const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.StitchFailed, "Could not check a sequence of photos");
          if (ScanFailures.stopsTheScan(e) || ++inARow >= PanoramaDetector.MAX_FAILURES_IN_A_ROW) stop.error ??= e;
          else stats.failures.push(e.toJSON());
        }
        inProgress.delete(sequence);
        stats.photosChecked += sequence.length;
      }
    };
    await Promise.all(this.#checkers.map(work));
    if (stop.error) throw stop.error;
    ctx.progress("Checking new photos", total, total);
    if (hidden.count > 0) stats.alreadyMade = hidden.count;
    return stats;
  }

  /** A group already made is not shown again, unless the user asked to re-check everything. */
  private emitGroup(g: OverlapGroup, byKey: Map<string, LibraryItem>, emit: (finding: PanoramaCandidate) => void, hidden: { count: number }): void {
    const keys = g.mediaKeys;
    const groupItems = keys.map((k) => byKey.get(k)!);
    const made = this.alreadyMade(groupItems);
    if (made?.covers && !this.recheck) {
      hidden.count++;
      return;
    }
    emit({
      id: `panorama:${keys[0]}:${keys.length}`,
      detector: "panorama",
      mediaKeys: keys,
      items: groupItems,
      preview: g.preview,
      thumbs: g.thumbs,
      alreadyMade: made,
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
}
