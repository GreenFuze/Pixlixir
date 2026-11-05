/**
 * Panorama candidates in a library scan.
 *
 * Two stages, after Hugin's "search for panoramas" (photos from the same camera, taken
 * moments apart) and graph-based panorama recognition (Brown & Lowe):
 *   1. TimeSequenceGrouper: runs of same-size photos taken within seconds of each other;
 *   2. an OverlapChecker (the stitching engine) keeps the photos of each run that really
 *      overlap, sets retakes aside, and may split a run into several panoramas.
 */

import type { LibraryItem } from "../domain/types.js";
import type { SerializedError } from "../shared/errors.js";
import type { ScanContext, ScanDetector, ScanFinding } from "./scan-detector.js";

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
  /** Camera motion the preview stitched with ("rotate" first, "flat" if that failed). */
  motion: "rotate" | "flat";
  /** Photos of the group the stitcher could not connect. */
  dropped: string[];
}

export interface OverlapGroup {
  mediaKeys: string[];
  duplicates: string[];
  preview: CandidatePreview | null;
  previewError: SerializedError | null;
}

/** Decides which photos of a time sequence overlap (and previews each group). */
export interface OverlapChecker {
  check(sequence: readonly LibraryItem[], signal: AbortSignal): Promise<OverlapGroup[]>;
}

export interface PanoramaCandidate extends ScanFinding {
  detector: "panorama";
  items: LibraryItem[];
  /** Retakes of photos already in the group (left out). */
  duplicates: LibraryItem[];
  preview: CandidatePreview | null;
  previewError: SerializedError | null;
  /** A panorama Pixlixir already saved from (most of) these photos. */
  alreadyMade: { webUrl: string } | null;
}

export class PanoramaDetector implements ScanDetector<PanoramaCandidate> {
  readonly id = "panorama" as const;
  readonly label = "Panoramas";
  readonly description = "Overlapping photos taken seconds apart, ready to stitch.";

  constructor(
    private readonly checker: OverlapChecker,
    /** Gets the group's items (album listings use album-specific keys; dedup keys are stable everywhere). */
    private readonly alreadyMade: (items: readonly LibraryItem[]) => { webUrl: string } | null,
    private readonly options: SequenceOptions = TimeSequenceGrouper.DEFAULTS,
  ) {}

  async analyze(items: readonly LibraryItem[], ctx: ScanContext, emit: (finding: PanoramaCandidate) => void): Promise<void> {
    // Paragraph: cheap pre-filter on capture times.
    const sequences = TimeSequenceGrouper.group(items, this.options);
    const byKey = new Map(items.map((i) => [i.mediaKey, i]));

    // Paragraph: confirm each sequence with the stitching engine.
    for (const [n, sequence] of sequences.entries()) {
      ctx.progress("Checking photos taken in sequence", n, sequences.length);
      for (const g of await this.checker.check(sequence, ctx.signal)) {
        const keys = g.mediaKeys;
        const groupItems = keys.map((k) => byKey.get(k)!);
        emit({
          id: `panorama:${keys[0]}:${keys.length}`,
          detector: "panorama",
          mediaKeys: keys,
          items: groupItems,
          duplicates: g.duplicates.map((k) => byKey.get(k)!),
          preview: g.preview,
          previewError: g.previewError,
          alreadyMade: this.alreadyMade(groupItems),
        });
      }
    }
    ctx.progress("Checking photos taken in sequence", sequences.length, sequences.length);
  }
}
