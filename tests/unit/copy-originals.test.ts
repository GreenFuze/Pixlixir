import { describe, expect, it } from "vitest";
import type { LibraryItem } from "../../src/domain/types.js";
import { OriginalFinder, type OriginalMatch } from "../../src/scan/copy-originals.js";
import type { PhotoPrint } from "../../src/scan/duplicates.js";
import type { LumaImage } from "../../src/scan/fine-check.js";
import { moved, view } from "../fixtures/scene.js";

function item(n: number, over: Partial<LibraryItem> = {}): LibraryItem {
  return { mediaKey: `AF1QipITEM${String(n).padStart(8, "0")}`, dedupKey: `dedup${n}`, type: "photo", width: 4000, height: 3000, takenAtMs: Date.UTC(2015, 0, n), timezoneOffsetMs: 0, baseUrl: `https://x/${n}`, location: null, ...over };
}

const LOOK_A: PhotoPrint = { hash: "0".repeat(64), tiny: new Uint8Array(768).fill(100) };
const LOOK_A_NEAR: PhotoPrint = { hash: "0".repeat(56) + "ffffff00", tiny: new Uint8Array(768).fill(104) };
const LOOK_B: PhotoPrint = { hash: "f".repeat(64), tiny: new Uint8Array(768).fill(200) };
const DETAIL_CLEAN = view(256, 192);
/** One small part of the picture is different, as with a label added to a copy. */
const DETAIL_LABELLED = view(256, 192, undefined, moved);

describe("OriginalFinder", () => {
  const ctx = { signal: new AbortController().signal, progress: () => {} };
  const memory = () => {
    const map = new Map<string, PhotoPrint>();
    return { map, get: async (k: string) => map.get(k) ?? null, put: async (k: string, v: PhotoPrint) => void map.set(k, v) };
  };

  async function run(copies: LibraryItem[], library: LibraryItem[], looks: Map<string, PhotoPrint>, cache = memory(), details = new Map<string, LumaImage | "unreadable">()) {
    const found: OriginalMatch[] = [];
    const read: string[] = [];
    const printer = {
      print: async (i: LibraryItem) => { read.push(i.dedupKey); const look = looks.get(i.dedupKey); if (!look) throw new Error("unreadable"); return look; },
      luma: async (i: LibraryItem) => { const seen = details.get(i.dedupKey); if (seen === "unreadable") throw new Error("unreadable"); return seen ?? DETAIL_CLEAN; },
    };
    const saved = new Map<string, number>();
    const detailCache = { get: async (k: string) => saved.get(k) ?? null, put: async (k: string, v: number) => void saved.set(k, v) };
    const stats = await new OriginalFinder(printer, cache, detailCache, { collect: async () => library }).run(copies, ctx, (m) => found.push(m));
    return { found, read, stats };
  }
  const copy = item(1, { width: 1080, height: 810 });

  it("finds the larger photo of the same picture, and only that", async () => {
    const original = item(2), other = item(3);
    const { found } = await run([copy], [copy, original, other], new Map([[copy.dedupKey, LOOK_A], [original.dedupKey, LOOK_A], [other.dedupKey, LOOK_B]]));
    expect(found).toEqual([{ copy, original, similarity: 100 }]);
  });

  it("never takes a smaller photo, another shape, a video or another copy as the original", async () => {
    const smaller = item(2, { width: 800, height: 600 }), wide = item(3, { width: 4000, height: 2000 }), video = item(4, { type: "video" }), second = item(5, { width: 2000, height: 1500 });
    const looks = new Map([copy, smaller, wide, video, second].map((i) => [i.dedupKey, LOOK_A]));
    const { found, read } = await run([copy, second], [copy, smaller, wide, video, second], looks);
    expect(found).toEqual([]);
    expect(read).not.toContain(video.dedupKey);
    expect(read).not.toContain(wide.dedupKey); // not even read
  });

  it("prefers the closest match, then the most pixels, then the oldest", async () => {
    const near = item(2, { width: 8000, height: 6000 }), same = item(3), bigger = item(4, { width: 4800, height: 3600 }), older = item(5, { width: 4800, height: 3600, takenAtMs: Date.UTC(2001, 0, 1) });
    const looks = new Map([[copy.dedupKey, LOOK_A], [near.dedupKey, LOOK_A_NEAR], [same.dedupKey, LOOK_A], [bigger.dedupKey, LOOK_A], [older.dedupKey, LOOK_A]]);
    const { found } = await run([copy], [copy, near, same, bigger, older], looks);
    expect(found[0]!.original).toBe(older);
    expect(found[0]!.similarity).toBe(100);
  });

  it("does not call a photo the same when part of it looks different, and prefers one that does match", async () => {
    const labelled = item(2, { width: 8000, height: 6000 }), clean = item(3);
    const looks = new Map([copy, labelled, clean].map((i) => [i.dedupKey, LOOK_A]));
    const both = await run([copy], [copy, labelled, clean], looks, memory(), new Map([[labelled.dedupKey, DETAIL_LABELLED]]));
    expect(both.found[0]).toMatchObject({ original: clean, similarity: 100 });
    const only = await run([copy], [copy, labelled], looks, memory(), new Map([[labelled.dedupKey, DETAIL_LABELLED]]));
    expect(only.found[0]!.similarity).toBeLessThan(95);
  });

  it("never calls a pair the same when its closer look could not be read", async () => {
    const original = item(2);
    const { found, stats } = await run([copy], [copy, original], new Map([[copy.dedupKey, LOOK_A], [original.dedupKey, LOOK_A]]), memory(), new Map([[original.dedupKey, "unreadable"]]));
    expect(found[0]!.similarity).toBe(99);
    expect(stats.unreadable).toBe(1);
  });

  it("counts photos it cannot read, and reuses saved prints", async () => {
    const original = item(2), lost = item(3);
    const cache = memory();
    cache.map.set(`v1|${original.dedupKey}`, LOOK_A);
    const { found, read, stats } = await run([copy], [copy, original, lost], new Map([[copy.dedupKey, LOOK_A]]), cache);
    expect(found).toHaveLength(1);
    expect(read).not.toContain(original.dedupKey);
    expect(stats.unreadable).toBe(1);
  });
});
