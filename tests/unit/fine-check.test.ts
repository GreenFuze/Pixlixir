import { describe, expect, it } from "vitest";
import type { LibraryItem } from "../../src/domain/types.js";
import { CropCandidates, CropLocator, FineCheck, FineComparer, LumaImage, WHOLE, type ClosePair, type Region } from "../../src/scan/fine-check.js";
import type { ScanCache } from "../../src/scan/scan-cache.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";
import { moved, view } from "../fixtures/scene.js";

const item = (n: number, over: Partial<LibraryItem> = {}): LibraryItem => ({ mediaKey: `AF1QipITEM${n}00000000`, dedupKey: `dedup${n}`, type: "photo", width: 4000, height: 3000, takenAtMs: 1_700_000_000_000, timezoneOffsetMs: 0, baseUrl: `https://x/${n}`, location: null, ...over });
const ctx = () => ({ signal: new AbortController().signal, progress: () => {} });
const numbers = (): ScanCache<number> & { map: Map<string, number> } => {
  const map = new Map<string, number>();
  return { map, get: async (k) => map.get(k) ?? null, put: async (k, v) => void map.set(k, v) };
};

describe("LumaImage", () => {
  it("averages what each new pixel covers, and takes a part of the picture", () => {
    const img = new LumaImage(4, 2, new Uint8Array([0, 100, 200, 100, 0, 100, 200, 100]));
    expect([...img.resized(2, 1).data]).toEqual([50, 150]);
    expect([...img.resized(1, 1, { x: 0.5, y: 0, w: 0.5, h: 1 }).data]).toEqual([150]);
  });

  it("refuses pixels that do not match the size", () => {
    expect(() => new LumaImage(2, 2, new Uint8Array(3))).toThrow(PixError);
  });
});

describe("FineComparer", () => {
  it("sees a moved person that a whole-picture average hides, and nothing in a resized copy", () => {
    const a = view(1024, 768);
    expect(FineComparer.compare(view(512, 384), a)).toBeLessThan(FineComparer.SAME_SQUARE_DIFF);
    expect(FineComparer.compare(view(1024, 768, WHOLE, moved), a)).toBeGreaterThan(FineComparer.SAME_SQUARE_DIFF);
  });

  it("compares a crop where it sits, at the size both show", () => {
    const where = { x: 0.2, y: 0.25, w: 0.5, h: 0.5 };
    const big = view(1024, 768);
    const crop = view(1000, 750, where); // the same part of the scene, finer than the big photo shows it
    expect(FineComparer.compare(crop, big, where)).toBeLessThan(FineComparer.SAME_SQUARE_DIFF);
  });

  it("refuses pictures of different sizes square by square", () => {
    expect(() => FineComparer.worstSquare(view(10, 10), view(12, 10))).toThrow(/different sizes/);
  });
});

describe("CropLocator", () => {
  it("finds where a crop sits in the larger photo", () => {
    // The scene spans the big photo, so a part 0.45 wide and 0.6 high of a 256 x 192 photo is square.
    const match = CropLocator.locate(view(200, 200, { x: 0.3, y: 0.1, w: 0.45, h: 0.6 }), view(256, 192))!;
    expect(match.agreement).toBeGreaterThan(0.95);
    expect(match.region.x).toBeCloseTo(0.3, 1);
    expect(match.region.y).toBeCloseTo(0.1, 1);
    expect(match.region.w).toBeCloseTo(0.45, 1);
    expect(match.region.h).toBeCloseTo(0.6, 1);
  });

  it("finds nothing in another picture", () => {
    const other = new LumaImage(256, 192, view(256, 192).data.map((v, i) => (v * 7 + i * 13) % 256));
    expect(CropLocator.locate(view(128, 128, { x: 0.2, y: 0.2, w: 0.4, h: 0.5 }), other)).toBeNull();
  });
});

describe("FineCheck", () => {
  const pair = (a: LibraryItem, b: LibraryItem, similarity = 100, region?: Region): ClosePair => ({ a, b, similarity, ...(region ? { region } : {}) });

  it("keeps 100% for a copy, drops a burst shot below the default, and saves each result", async () => {
    const reads: string[] = [];
    const looks = new Map([["dedup1", view(1024, 768)], ["dedup2", view(512, 384)], ["dedup3", view(1024, 768, WHOLE, moved)]]);
    const reader = { luma: async (i: LibraryItem) => { reads.push(i.dedupKey); return looks.get(i.dedupKey)!; } };
    const cache = numbers();
    const pairs = [pair(item(2), item(1)), pair(item(3), item(1)), pair(item(4), item(1), 80)];
    const first = await new FineCheck(reader, cache).rescore(pairs, ctx());
    expect(first.similarities[0]).toBe(100);
    expect(first.similarities[1]).toBeLessThan(95);
    expect(first.similarities[2]).toBe(80); // too far apart to need it
    expect(reads.filter((k) => k === "dedup1")).toHaveLength(1); // read once for both pairs
    await new FineCheck(reader, cache).rescore(pairs, ctx());
    expect(reads).toHaveLength(3); // saved
  });

  it("never calls an unreadable pair the same, and stops on a problem that hits everything", async () => {
    const reader = { luma: async () => { throw new PixError(ErrorCode.MediaFetchFailed, "gone"); } };
    const r = await new FineCheck(reader, numbers()).rescore([pair(item(1), item(2))], ctx());
    expect(r).toEqual({ similarities: [99], unreadable: 2 });
    const stopping = { luma: async () => { throw new PixError(ErrorCode.AccountMismatch, "other"); } };
    await expect(new FineCheck(stopping, numbers()).rescore([pair(item(1), item(2))], ctx())).rejects.toMatchObject({ code: ErrorCode.AccountMismatch });
  });

  it("only lowers a score", () => {
    expect(FineCheck.after(97, 0)).toBe(97);
    expect(FineCheck.after(100, FineComparer.SAME_SQUARE_DIFF)).toBe(100);
    expect(FineCheck.after(100, FineComparer.SAME_SQUARE_DIFF + 1)).toBe(99);
    expect(FineCheck.after(90, FineComparer.SAME_SQUARE_DIFF + 2)).toBe(90);
    expect(FineCheck.after(100, 250)).toBe(FineCheck.MIN_PERCENT);
  });
});

describe("CropCandidates", () => {
  it("pairs a smaller photo saved within seconds, never same-size bursts or photos far apart", () => {
    const big = item(1), crop = item(2, { width: 2000, height: 2400, takenAtMs: big.takenAtMs + 1000 });
    const burst = item(3, { takenAtMs: big.takenAtMs + 500 });
    const later = item(4, { width: 2000, height: 2000, takenAtMs: big.takenAtMs + 60_000 });
    const larger = item(5, { width: 5000, height: 1000, takenAtMs: big.takenAtMs + 200 });
    expect(CropCandidates.pairs([big, crop, burst, later, larger], new Set()).map(([s, b]) => [s.dedupKey, b.dedupKey])).toEqual([["dedup2", "dedup1"], ["dedup2", "dedup3"]]);
    expect(CropCandidates.pairs([big, crop], new Set(["dedup1|dedup2"]))).toEqual([]);
  });

  it("skips batches that share one time, as imports do", () => {
    const batch = Array.from({ length: CropCandidates.MAX_NEIGHBOURS + 2 }, (_, n) => item(10 + n, { width: 4000 - n * 100, height: 3000 - n * 100 }));
    expect(CropCandidates.pairs(batch, new Set())).toEqual([]);
    expect(CropCandidates.pairs(batch.slice(0, 2), new Set())).toHaveLength(1);
  });
});
