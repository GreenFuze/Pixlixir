/**
 * Whether two photos are the same image, compared at up to 1024 px: every small square of the
 * picture must match, so burst shots taken a second apart are told from copies. A crop is lined up
 * first and compared where it overlaps. Measured on the owner's library: ADR-0008.
 */

import pLimit from "p-limit";
import type { LibraryItem } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";
import type { ScanCache } from "./scan-cache.js";
import { ScanFailures, type ScanContext } from "./scan-detector.js";

/** Part of a picture, as fractions of its width and height. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const WHOLE: Region = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/** A photo's brightness, one byte per pixel. */
export class LumaImage {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Uint8Array,
  ) {
    if (width < 1 || height < 1 || data.length !== width * height) {
      throw new PixError(ErrorCode.InvalidImage, "A photo's pixels do not match its size", { width, height, length: data.length });
    }
  }

  static fromRgba(rgba: Uint8ClampedArray, width: number, height: number): LumaImage {
    const out = new Uint8Array(width * height);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!);
    return new LumaImage(width, height, out);
  }

  /** The part of the picture in `region`, resized to width x height by averaging what each new pixel covers. */
  resized(width: number, height: number, region: Region = WHOLE): LumaImage {
    const cols = LumaImage.spans(region.x * this.width, region.w * this.width, width, this.width);
    const rows = LumaImage.spans(region.y * this.height, region.h * this.height, height, this.height);

    // Paragraph: across, then down; only the rows the part covers.
    const first = rows[0]!.start, last = rows[rows.length - 1]!.start + rows[rows.length - 1]!.weights.length;
    const across = new Float32Array(this.height * width);
    for (let y = first; y < last; y++) {
      const row = y * this.width;
      for (let x = 0; x < width; x++) {
        const span = cols[x]!;
        let sum = 0;
        for (let k = 0; k < span.weights.length; k++) sum += this.data[row + span.start + k]! * span.weights[k]!;
        across[y * width + x] = sum;
      }
    }
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const span = rows[y]!;
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = 0; k < span.weights.length; k++) sum += across[(span.start + k) * width + x]! * span.weights[k]!;
        out[y * width + x] = Math.round(sum);
      }
    }
    return new LumaImage(width, height, out);
  }

  /** Which source pixels each of `count` new pixels covers, and how much of each, inside the picture. */
  private static spans(from: number, length: number, count: number, limit: number): { start: number; weights: Float32Array }[] {
    const step = length / count;
    return Array.from({ length: count }, (_, i) => {
      // Paragraph: a new pixel smaller than a source pixel still averages one pixel's worth around its centre.
      const centre = from + (i + 0.5) * step;
      const half = Math.max(step, 1) / 2;
      const a = Math.max(0, Math.min(limit - 1e-6, centre - half));
      const b = Math.max(a + 1e-6, Math.min(limit, centre + half));
      const start = Math.floor(a);
      const end = Math.ceil(b);
      const weights = new Float32Array(end - start);
      for (let p = start; p < end; p++) weights[p - start] = Math.min(b, p + 1) - Math.max(a, p);
      const total = weights.reduce((s, w) => s + w, 0);
      for (let k = 0; k < weights.length; k++) weights[k]! /= total;
      return { start, weights };
    });
  }
}

/** Compares two photos square by square. */
export class FineComparer {
  /** Squares across the picture: 16 px at 1024. */
  static readonly ACROSS = 64;
  /** Smaller squares only measure the noise of compression. */
  static readonly MIN_SQUARE = 8;
  /**
   * No square further apart than this: the same image. Measured on 120 real photos (ADR-0008): copies
   * at another size or at JPEG 60% stayed at 29.5 or less; 276 of 278 close burst shots went over.
   */
  static readonly SAME_SQUARE_DIFF = 35;

  /** The mean brightness difference in the square that differs most, 0 to 255. */
  static worstSquare(a: LumaImage, b: LumaImage): number {
    if (a.width !== b.width || a.height !== b.height) throw new PixError(ErrorCode.Internal, "Pictures of different sizes cannot be compared square by square", { a: [a.width, a.height], b: [b.width, b.height] });
    const side = Math.max(FineComparer.MIN_SQUARE, Math.floor(a.width / FineComparer.ACROSS));
    let worst = 0;
    for (let y = 0; y < a.height; y += side) {
      for (let x = 0; x < a.width; x += side) {
        const h = Math.min(side, a.height - y), w = Math.min(side, a.width - x);
        let sum = 0;
        for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) sum += Math.abs(a.data[j * a.width + i]! - b.data[j * a.width + i]!);
        worst = Math.max(worst, sum / (w * h));
      }
    }
    return worst;
  }

  /** `small` against `big`, or against the part of `big` in `region`, at the finer of the two sizes both show. */
  static compare(small: LumaImage, big: LumaImage, region: Region = WHOLE): number {
    const width = Math.max(1, Math.min(small.width, Math.round(region.w * big.width)));
    const height = Math.max(1, Math.round((width * small.height) / small.width));
    const mine = small.width === width && small.height === height ? small : small.resized(width, height);
    if (region === WHOLE) return FineComparer.worstSquare(mine, big.resized(width, height));
    return FineComparer.worstSquare(mine, big.resized(width, height, CropLocator.refine(mine, big, region)));
  }
}

export interface CropMatch {
  /** Where the small photo sits in the big one. */
  region: Region;
  /** Normalised correlation where it sits, 0 to 1. */
  agreement: number;
}

/** Finds where a cropped copy sits in a larger photo, at any scale down to MIN_SCALE. */
export class CropLocator {
  static readonly SEARCH_SIDE = 64;
  static readonly REFINE_SIDE = 256;
  /** The crop is at least this part of the big photo's width. */
  static readonly MIN_SCALE = 0.3;
  private static readonly SCALE_STEP = 0.95;
  private static readonly MIN_TEMPLATE = 12;
  /** Lined-up crops of real photos reached it; 398 of 400 real candidates, nearly all no crop, stayed below it (ADR-0008). */
  static readonly MIN_AGREEMENT = 0.9;

  /** Null when no part of `big` looks like `small`. Both are about REFINE_SIDE on their long side. */
  static locate(small: LumaImage, big: LumaImage): CropMatch | null {
    // Paragraph: every scale and place, small.
    const bigSearch = CropLocator.fit(big, CropLocator.SEARCH_SIDE);
    let best: { scale: number; x: number; y: number; agreement: number } | null = null;
    for (let scale = 1; scale >= CropLocator.MIN_SCALE; scale *= CropLocator.SCALE_STEP) {
      const tw = Math.round(scale * bigSearch.width);
      const th = Math.round((tw * small.height) / small.width);
      if (th > bigSearch.height || tw < CropLocator.MIN_TEMPLATE || th < CropLocator.MIN_TEMPLATE) continue;
      const found = CropLocator.bestPlace(small.resized(tw, th), bigSearch, 0, bigSearch.width - tw, 0, bigSearch.height - th);
      if (!best || found.agreement > best.agreement) best = { scale, ...found };
    }
    if (!best) return null;

    // Paragraph: then finer, around the best.
    const bigFine = CropLocator.fit(big, CropLocator.REFINE_SIDE);
    const k = bigFine.width / bigSearch.width;
    let fine = { scale: best.scale, x: best.x * k, y: best.y * k, tw: 0, th: 0, agreement: -1 };
    for (let n = -6; n <= 6; n++) {
      const scale = best.scale * (1 + n * 0.005);
      const tw = Math.round(scale * bigFine.width);
      const th = Math.round((tw * small.height) / small.width);
      if (tw > bigFine.width || th > bigFine.height) continue;
      const cx = Math.round(best.x * k), cy = Math.round(best.y * k), r = Math.ceil(k);
      const found = CropLocator.bestPlace(small.resized(tw, th), bigFine, Math.max(0, cx - r), Math.min(bigFine.width - tw, cx + r), Math.max(0, cy - r), Math.min(bigFine.height - th, cy + r));
      if (found.agreement > fine.agreement) fine = { scale, ...found, tw, th };
    }
    if (fine.agreement < CropLocator.MIN_AGREEMENT) return null;
    // Paragraph: the height from the crop's own shape, not from rounded pixels.
    const h = (fine.tw * small.height) / small.width / bigFine.height;
    return { region: { x: fine.x / bigFine.width, y: fine.y / bigFine.height, w: fine.tw / bigFine.width, h: Math.min(h, 1 - fine.y / bigFine.height) }, agreement: fine.agreement };
  }

  /**
   * Moves and scales `region` to where `small` matches best, finer at each step: the search above
   * is at 256 px, where one pixel is four at 1024, and an error that small shows as edges that differ.
   */
  static refine(small: LumaImage, big: LumaImage, region: Region): Region {
    let best = region;
    for (const level of CropLocator.LEVELS) {
      const width = Math.min(small.width, level.width ?? small.width);
      const t = width === small.width ? small : small.resized(width, Math.max(1, Math.round((width * small.height) / small.width)));

      // Paragraph: the big photo shrunk once to about this step's detail, so each try reads less.
      const shrink = Math.min(1, (1.5 * width) / (best.w * big.width));
      const source = shrink > 0.9 ? big : big.resized(Math.max(1, Math.round(big.width * shrink)), Math.max(1, Math.round(big.height * shrink)));
      best = CropLocator.bestNear(t, source, best, level);
    }
    return best;
  }

  /** From coarse to fine: pixels at each width, how many steps each way, and the scales tried. */
  private static readonly LEVELS: readonly { width?: number; radius: number; step: number; scales: readonly number[] }[] = [
    { width: 256, radius: 2, step: 1, scales: [0.995, 1, 1.005] },
    { width: 512, radius: 2, step: 1, scales: [0.997, 1, 1.003] },
    { radius: 1, step: 0.5, scales: [1] },
    { radius: 1, step: 0.25, scales: [1] },
  ];

  private static bestNear(t: LumaImage, big: LumaImage, around: Region, level: { radius: number; step: number; scales: readonly number[] }): Region {
    const px = around.w / t.width, py = around.h / t.height;
    let best = { region: around, diff: CropLocator.meanDiff(t, big, around) };
    for (const scale of level.scales) {
      const w = around.w * scale, h = around.h * scale;
      for (let dy = -level.radius; dy <= level.radius; dy++) {
        for (let dx = -level.radius; dx <= level.radius; dx++) {
          const candidate = { x: around.x + dx * level.step * px + (around.w - w) / 2, y: around.y + dy * level.step * py + (around.h - h) / 2, w, h };
          if (candidate.x < 0 || candidate.y < 0 || candidate.x + candidate.w > 1 + 1e-9 || candidate.y + candidate.h > 1 + 1e-9) continue;
          const diff = CropLocator.meanDiff(t, big, candidate);
          if (diff < best.diff) best = { region: candidate, diff };
        }
      }
    }
    return best.region;
  }

  /** Mean brightness difference between `t` and the part of `big` in `region` at the same size. */
  private static meanDiff(t: LumaImage, big: LumaImage, region: Region): number {
    const other = big.resized(t.width, t.height, region);
    let sum = 0;
    for (let i = 0; i < t.data.length; i++) sum += Math.abs(t.data[i]! - other.data[i]!);
    return sum / t.data.length;
  }

  private static fit(image: LumaImage, side: number): LumaImage {
    const k = Math.min(1, side / Math.max(image.width, image.height));
    return image.resized(Math.max(1, Math.round(image.width * k)), Math.max(1, Math.round(image.height * k)));
  }

  /** The place in `big` (top-left within the given bounds) where `t` correlates best. */
  private static bestPlace(t: LumaImage, big: LumaImage, x0: number, x1: number, y0: number, y1: number): { x: number; y: number; agreement: number } {
    // Paragraph: the template's own mean and spread, once.
    const n = t.width * t.height;
    let tSum = 0, tSq = 0;
    for (let i = 0; i < n; i++) { tSum += t.data[i]!; tSq += t.data[i]! * t.data[i]!; }
    const tVar = tSq - (tSum * tSum) / n;
    let best = { x: x0, y: y0, agreement: -1 };
    if (tVar <= 0) return best;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let bSum = 0, bSq = 0, cross = 0;
        for (let j = 0; j < t.height; j++) {
          const row = (y + j) * big.width + x, trow = j * t.width;
          for (let i = 0; i < t.width; i++) {
            const v = big.data[row + i]!;
            bSum += v; bSq += v * v; cross += v * t.data[trow + i]!;
          }
        }
        const bVar = bSq - (bSum * bSum) / n;
        if (bVar <= 0) continue;
        const agreement = (cross - (bSum * tSum) / n) / Math.sqrt(bVar * tVar);
        if (agreement > best.agreement) best = { x, y, agreement };
      }
    }
    return best;
  }
}

/** Reads a photo's brightness from Google's rendition. */
export interface PhotoLumaReader {
  luma(item: LibraryItem, maxSide: number): Promise<LumaImage>;
}

/** Two photos to compare: `a` against `b`, or against the part of `b` in `region` when `a` is a crop of it. */
export interface ClosePair {
  a: LibraryItem;
  b: LibraryItem;
  similarity: number;
  region?: Region;
}

/** Keeps a few photos' pixels while their pairs are compared, and reads each at most once while kept. */
export class LumaShelf {
  readonly #kept = new Map<string, Promise<LumaImage>>();

  constructor(
    private readonly reader: PhotoLumaReader,
    private readonly side: number,
    private readonly capacity: number,
  ) {}

  get(item: LibraryItem): Promise<LumaImage> {
    const kept = this.#kept.get(item.dedupKey);
    if (kept) {
      this.#kept.delete(item.dedupKey);
      this.#kept.set(item.dedupKey, kept);
      return kept;
    }
    const read = this.reader.luma(item, this.side);
    this.#kept.set(item.dedupKey, read);
    read.catch(() => this.#kept.delete(item.dedupKey));
    while (this.#kept.size > this.capacity) this.#kept.delete(this.#kept.keys().next().value!);
    return read;
  }
}

/**
 * The close pairs, looked at square by square at up to 1024 px. Each pair's result is saved, so a
 * later scan reads nothing again; the pixels themselves are too large to keep.
 */
export class FineCheck {
  static readonly READ_SIDE = 1024;
  /** Pairs this close get the check: lower scores cannot reach the default setting. */
  static readonly FROM = 88;
  static readonly VERSION = 1;
  /** Beyond the limit, each percent lost: a burst shot falls below the default setting. */
  static readonly DIFF_PER_PERCENT = 2;
  static readonly MIN_PERCENT = 75;
  private static readonly PARALLEL = 4;
  private static readonly KEPT = 32;

  constructor(
    private readonly reader: PhotoLumaReader,
    private readonly cache: ScanCache<number>,
    private readonly recheck: boolean = false,
  ) {}

  static key(pair: ClosePair): string {
    const r = pair.region;
    return `fine-v${FineCheck.VERSION}|${pair.a.dedupKey}|${pair.b.dedupKey}|${r ? [r.x, r.y, r.w, r.h].map((v) => v.toFixed(4)).join(",") : "whole"}`;
  }

  /** Each pair's score, in order, and how many photos could not be read. */
  async rescore(pairs: readonly ClosePair[], ctx: ScanContext, step = "Looking closer"): Promise<{ similarities: number[]; unreadable: number }> {
    // Paragraph: saved results first.
    const worst = new Map<number, number>();
    const todo: number[] = [];
    for (const [n, pair] of pairs.entries()) {
      if (pair.similarity < FineCheck.FROM) continue;
      const saved = this.recheck ? null : await this.cache.get(FineCheck.key(pair));
      if (saved !== null) worst.set(n, saved);
      else todo.push(n);
    }

    // Paragraph: the rest, pairs of the same photos together so each is read once.
    todo.sort((x, y) => FineCheck.order(pairs[x]!).localeCompare(FineCheck.order(pairs[y]!)));
    const shelf = new LumaShelf(this.reader, FineCheck.READ_SIDE, FineCheck.KEPT);
    const unreadable = new Set<string>();
    const stop: { error: PixError | null } = { error: null };
    const limit = pLimit(FineCheck.PARALLEL);
    let done = 0;
    await Promise.all(todo.map((n) => limit(async () => {
      if (stop.error) return;
      if (ctx.signal.aborted) {
        stop.error = new PixError(ErrorCode.Cancelled, "The scan was stopped");
        return;
      }
      ctx.progress(step, done, todo.length);
      const pair = pairs[n]!;
      try {
        const [a, b] = await Promise.all([FineCheck.readOrNull(shelf, pair.a, unreadable), FineCheck.readOrNull(shelf, pair.b, unreadable)]);
        if (a && b) {
          const value = FineComparer.compare(a, b, pair.region);
          worst.set(n, value);
          await this.cache.put(FineCheck.key(pair), value);
        }
      } catch (err) {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not compare two photos");
        if (ScanFailures.stopsTheScan(e)) stop.error ??= e;
      }
      done++;
    })));
    if (stop.error) throw stop.error;

    // Paragraph: a pair that could not be compared is never called the same.
    const similarities = pairs.map((p, n) => {
      if (p.similarity < FineCheck.FROM) return p.similarity;
      const w = worst.get(n);
      return w === undefined ? FineCheck.unconfirmed(p.similarity) : FineCheck.after(p.similarity, w);
    });
    return { similarities, unreadable: unreadable.size };
  }

  /** The score once every square has been compared. It can only fall. */
  static after(similarity: number, worst: number): number {
    if (worst <= FineComparer.SAME_SQUARE_DIFF) return similarity;
    const seen = Math.round(99 - (worst - FineComparer.SAME_SQUARE_DIFF) / FineCheck.DIFF_PER_PERCENT);
    return Math.max(FineCheck.MIN_PERCENT, Math.min(similarity, seen));
  }

  /** A pair that could not be compared is not known to be the same. */
  static unconfirmed(similarity: number): number {
    return Math.min(99, similarity);
  }

  private static order(pair: ClosePair): string {
    return [pair.a.dedupKey, pair.b.dedupKey].sort().join("|");
  }

  /** Null when the photo cannot be read; a failure that stops the scan is thrown. */
  static async readOrNull(shelf: LumaShelf, item: LibraryItem, unreadable: Set<string>): Promise<LumaImage | null> {
    try {
      return await shelf.get(item);
    } catch (err) {
      const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.MediaFetchFailed, "Could not read a photo");
      if (ScanFailures.stopsTheScan(e)) throw e;
      unreadable.add(item.dedupKey);
      return null;
    }
  }
}

/**
 * Photos that may be crops of each other: saved within a few seconds, as an editor's "save copy"
 * keeps the time, and smaller on at least one side. Crops saved with another time are not found.
 */
export class CropCandidates {
  static readonly MAX_APART_MS = 2_000;
  /**
   * A photo with more photos than this within MAX_APART_MS is in a batch that shares one time, as
   * imports often do: 16,467 of 103,150 photos on the owner's library had over 20, which made 131,394
   * pairs; this limit leaves 3,393 (ADR-0008).
   */
  static readonly MAX_NEIGHBOURS = 5;
  /** A side this much smaller counts as cut. */
  private static readonly CUT = 0.98;

  /** [crop, larger photo] pairs not already in `linked` (keys "a|b" in either order). */
  static pairs(photos: readonly LibraryItem[], linked: ReadonlySet<string>): [LibraryItem, LibraryItem][] {
    const sorted = [...photos].sort((p, q) => p.takenAtMs - q.takenAtMs);
    const near = (i: number, j: number) => j < sorted.length && sorted[j]!.takenAtMs - sorted[i]!.takenAtMs <= CropCandidates.MAX_APART_MS;

    // Paragraph: how many others each photo has within the window.
    const neighbours = new Uint32Array(sorted.length);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; near(i, j); j++) { neighbours[i]!++; neighbours[j]!++; }
    }

    const out: [LibraryItem, LibraryItem][] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (neighbours[i]! > CropCandidates.MAX_NEIGHBOURS) continue;
      for (let j = i + 1; near(i, j); j++) {
        if (neighbours[j]! > CropCandidates.MAX_NEIGHBOURS) continue;
        const [small, big] = CropCandidates.ordered(sorted[i]!, sorted[j]!);
        if (!CropCandidates.couldBeCrop(small, big)) continue;
        if (linked.has(`${small.dedupKey}|${big.dedupKey}`) || linked.has(`${big.dedupKey}|${small.dedupKey}`)) continue;
        out.push([small, big]);
      }
    }
    return out;
  }

  /** Fewer pixels first. */
  private static ordered(a: LibraryItem, b: LibraryItem): [LibraryItem, LibraryItem] {
    return a.width * a.height <= b.width * b.height ? [a, b] : [b, a];
  }

  /** No side larger, and at least one side smaller: photos of the same size are bursts, not crops. */
  static couldBeCrop(small: LibraryItem, big: LibraryItem): boolean {
    const narrower = small.width / big.width, shorter = small.height / big.height;
    if (narrower > 1 || shorter > 1) return false;
    return narrower < CropCandidates.CUT || shorter < CropCandidates.CUT;
  }
}

/** What was found for one crop candidate; saved so a later scan reads nothing again. */
export interface CropResult {
  region: Region | null;
}

/** Lines up each crop candidate with its larger photo, at REFINE_SIDE. */
export class CropFinder {
  static readonly VERSION = 1;
  private static readonly PARALLEL = 4;

  constructor(
    private readonly reader: PhotoLumaReader,
    private readonly cache: ScanCache<CropResult>,
    private readonly recheck: boolean = false,
  ) {}

  /** A pair for each crop that sits in its larger photo, to be confirmed by FineCheck; and how many photos could not be read. */
  async run(candidates: readonly [LibraryItem, LibraryItem][], ctx: ScanContext): Promise<{ pairs: ClosePair[]; unreadable: number }> {
    const pairs: ClosePair[] = [];
    const unreadable = new Set<string>();
    const shelf = new LumaShelf(this.reader, CropLocator.REFINE_SIDE, 64);
    const limit = pLimit(CropFinder.PARALLEL);
    const stop: { error: PixError | null } = { error: null };
    let done = 0;
    await Promise.all(candidates.map(([small, big]) => limit(async () => {
      if (stop.error) return;
      if (ctx.signal.aborted) {
        stop.error = new PixError(ErrorCode.Cancelled, "The scan was stopped");
        return;
      }
      ctx.progress("Looking for crops", done, candidates.length);
      try {
        const key = `crop-v${CropFinder.VERSION}|${small.dedupKey}|${big.dedupKey}`;
        let found = this.recheck ? null : await this.cache.get(key);
        if (!found) {
          const [s, b] = await Promise.all([FineCheck.readOrNull(shelf, small, unreadable), FineCheck.readOrNull(shelf, big, unreadable)]);
          if (s && b) {
            found = { region: CropLocator.locate(s, b)?.region ?? null };
            await this.cache.put(key, found);
          }
        }
        if (found?.region) pairs.push({ a: small, b: big, similarity: 100, region: found.region });
      } catch (err) {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not compare two photos");
        if (ScanFailures.stopsTheScan(e)) stop.error ??= e;
      }
      done++;
    })));
    if (stop.error) throw stop.error;
    return { pairs, unreadable: unreadable.size };
  }
}
