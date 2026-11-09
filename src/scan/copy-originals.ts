/**
 * Finds the original of a saved copy, by what it looks like. The copy's file name holds the day it
 * was saved, so the date has to come from a larger photo of the same picture (ADR-0007). Each pair
 * is shown to the user, since the match is only a likeness. The test on a real library: ADR-0008.
 */

import type { LibraryItem } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";
import { PrintComparer, SavedPhotoReader, type PhotoPrint, type PhotoReader } from "./duplicates.js";
import { FineCheck, type ClosePair } from "./fine-check.js";
import type { ScanCache } from "./scan-cache.js";
import type { ScanContext } from "./scan-detector.js";
import type { ScanScope } from "./scan-scope.js";

export interface OriginalMatch {
  copy: LibraryItem;
  original: LibraryItem;
  similarity: number;
}

export interface LibraryLister {
  collect(scope: ScanScope, onCount: (count: number) => void, signal: AbortSignal): Promise<LibraryItem[]>;
}

export class OriginalFinder {
  constructor(
    private readonly printer: PhotoReader,
    private readonly cache: ScanCache<PhotoPrint>,
    private readonly fine: ScanCache<number>,
    private readonly library: LibraryLister,
  ) {}

  /** Reports the best match of each copy. Returns how many photos could not be read. */
  async run(copies: readonly LibraryItem[], ctx: ScanContext, onMatch: (match: OriginalMatch) => void): Promise<{ unreadable: number }> {
    // Paragraph: only larger photos of the same shape can be an original.
    const all = await this.library.collect({ kind: "library" }, (count) => ctx.progress(`Listing the library: ${count.toLocaleString()}`), ctx.signal);
    const known = new Set(copies.map((c) => c.dedupKey));
    const pool = all.filter((i) => !known.has(i.dedupKey) && i.type === "photo" && i.width > 0 && i.height > 0 && copies.some((c) => OriginalFinder.couldBeOriginal(c, i)));

    // Paragraph: what each looks like, from saved prints where there are any. Duplicates shares these.
    const { values: prints, unreadable } = await SavedPhotoReader.prints(this.printer, this.cache, false).run([...copies, ...pool], ctx, "Reading photos");

    // Paragraph: everything that could be each copy's original.
    const readable = pool.filter((p) => prints.has(p.dedupKey));
    const hashes = PrintComparer.hashes(readable.map((p) => prints.get(p.dedupKey)!));
    const pairs: ClosePair[] = [];
    for (const [n, copy] of copies.entries()) {
      if (ctx.signal.aborted) throw new PixError(ErrorCode.Cancelled, "The search was stopped");
      ctx.progress("Comparing photos", n, copies.length);
      await new Promise((r) => setTimeout(r));
      const print = prints.get(copy.dedupKey);
      if (print) pairs.push(...OriginalFinder.likely(copy, print, readable, hashes, (i) => prints.get(readable[i]!.dedupKey)!));
    }

    // Paragraph: every square of the close ones, then the best of each copy.
    const { similarities, unreadable: unseen } = await new FineCheck(this.printer, this.fine).rescore(pairs, ctx);
    const best = new Map<string, OriginalMatch>();
    for (const [n, pair] of pairs.entries()) {
      const match: OriginalMatch = { copy: pair.a, original: pair.b, similarity: similarities[n]! };
      const current = best.get(pair.a.dedupKey);
      if (!current || OriginalFinder.better(match, current)) best.set(pair.a.dedupKey, match);
    }
    for (const copy of copies) {
      const match = best.get(copy.dedupKey);
      if (match) onMatch(match);
    }
    return { unreadable: unreadable + unseen };
  }

  private static couldBeOriginal(copy: LibraryItem, item: LibraryItem): boolean {
    return item.width * item.height > copy.width * copy.height && copy.height > 0 && Math.abs(copy.width / copy.height - item.width / item.height) <= PrintComparer.MAX_ASPECT_DIFF;
  }

  private static likely(copy: LibraryItem, print: PhotoPrint, pool: readonly LibraryItem[], hashes: Uint32Array, printOf: (index: number) => PhotoPrint): ClosePair[] {
    const words = PrintComparer.hashes([print]);
    const pairs: ClosePair[] = [];
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i]!;
      if (!OriginalFinder.couldBeOriginal(copy, item)) continue;
      const similarity = PrintComparer.similarity(words, 0, hashes, i, print, () => printOf(i));
      if (similarity !== null) pairs.push({ a: copy, b: item, similarity });
    }
    return pairs;
  }

  /** Closest first, then the most pixels, then the oldest. */
  private static better(a: OriginalMatch, b: OriginalMatch): boolean {
    const pixels = (m: OriginalMatch) => m.original.width * m.original.height;
    return a.similarity > b.similarity
      || (a.similarity === b.similarity && (pixels(a) > pixels(b) || (pixels(a) === pixels(b) && a.original.takenAtMs < b.original.takenAtMs)));
  }
}
