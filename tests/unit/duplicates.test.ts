import { bmvbhash } from "blockhash-core";
import { describe, expect, it } from "vitest";
import type { AlbumRef, ItemDetails, LibraryItem, Page } from "../../src/domain/types.js";
import { DuplicateGrouper, DuplicatePlans, DuplicatesDetector, DuplicateSimilarity, DuplicateTrasher, PrintComparer, type DuplicateIndex, type DuplicatePhoto, type PhotoPrint } from "../../src/scan/duplicates.js";
import type { ScanCache } from "../../src/scan/scan-cache.js";
import { TrashMover } from "../../src/scan/trash-mover.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";

const item = (n: number, over: Partial<LibraryItem> = {}): LibraryItem => ({ mediaKey: `AF1QipITEM${n}00000000`, dedupKey: `dedupITEM${n}00000`, type: "photo", width: 4000, height: 3000, takenAtMs: 1_700_000_000_000 + n * 86_400_000, timezoneOffsetMs: 0, baseUrl: `https://x/${n}`, location: null, ...over });
const photo = (n: number, over: Partial<LibraryItem> = {}, sizeBytes: number | null = null): DuplicatePhoto => ({ item: item(n, over), sizeBytes });
const hex = (flipped: number) => {
  // A 256-bit hash with this many leading bits set.
  const bits = Array.from({ length: 256 }, (_, i) => (i < flipped ? 1 : 0));
  let out = "";
  for (let i = 0; i < 256; i += 4) out += parseInt(bits.slice(i, i + 4).join(""), 2).toString(16);
  return out;
};
const tiny = (value: number) => new Uint8Array(16 * 16 * 3).fill(value);
const print = (flipped: number, shade = 100): PhotoPrint => ({ hash: hex(flipped), tiny: tiny(shade) });
const signal = new AbortController().signal;
const ctx = () => ({ signal, progress: () => {} });
const memoryCache = (): ScanCache<PhotoPrint> & { map: Map<string, PhotoPrint> } => {
  const map = new Map<string, PhotoPrint>();
  return { map, get: async (k) => map.get(k) ?? null, put: async (k, v) => void map.set(k, v) };
};

describe("DuplicateSimilarity", () => {
  it("is 100% only when both the hash and the pixels say it is the same picture", () => {
    expect(DuplicateSimilarity.score(0, 0)).toBe(100);
    expect(DuplicateSimilarity.score(DuplicateSimilarity.SAME_DISTANCE, DuplicateSimilarity.SAME_PIXEL_DIFF)).toBe(100);
    expect(DuplicateSimilarity.score(0, DuplicateSimilarity.SAME_PIXEL_DIFF + 1)).toBe(99);
    expect(DuplicateSimilarity.score(DuplicateSimilarity.SAME_DISTANCE + 1, 0)).toBeLessThan(100);
  });

  it("falls with distance, down to the lowest setting", () => {
    expect(DuplicateSimilarity.score(32, 10)).toBe(DuplicateSimilarity.MIN_PERCENT);
    expect(DuplicateSimilarity.score(16, 10)).toBe(88);
  });

  it("rejects a hash that matches by accident: measured pairs at distance 20 with pixels 52 apart", () => {
    expect(DuplicateSimilarity.score(20, 52)).toBeNull();
    expect(DuplicateSimilarity.score(DuplicateSimilarity.MAX_DISTANCE + 1, 0)).toBeNull();
  });
});

describe("PrintComparer", () => {
  it("finds close pairs of the same shape only", async () => {
    const items = [item(1), item(2), item(3, { width: 3000, height: 4000 }), item(4)];
    const prints = [print(0), print(8), print(0), print(200)];
    const links = await PrintComparer.links(items, prints, signal, () => {});
    expect(links).toEqual([{ a: 0, b: 1, similarity: 100 }]); // 3 is rotated, 4 is 200 bits away
  });

  it("stops when the scan is stopped", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(PrintComparer.links([item(1), item(2)], [print(0), print(0)], ctrl.signal, () => {})).rejects.toMatchObject({ code: ErrorCode.Cancelled });
  });

  it("fails on a damaged saved print rather than comparing nonsense", async () => {
    await expect(PrintComparer.links([item(1)], [{ hash: "abc", tiny: tiny(0) }], signal, () => {})).rejects.toBeInstanceOf(PixError);
    expect(() => PrintComparer.pixelDiff(new Uint8Array(3), new Uint8Array(6))).toThrow(PixError);
  });
});

describe("blockhash-core as the hash", () => {
  const image = (draw: (x: number, y: number) => number) => {
    const data = new Uint8ClampedArray(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const v = draw(x, y); data.set([v, v, v, 255], (y * 64 + x) * 4); }
    return { width: 64, height: 64, data };
  };
  const waves = (x: number, y: number) => (Math.sin(x / 5) + Math.cos(y / 7)) * 60 + 128;
  const rings = (x: number, y: number) => Math.sin(Math.hypot(x - 20, y - 40) / 3) * 120 + 128;

  it("gives the 64 hex digits the comparer reads, the same for the same picture and not for another", async () => {
    const same = bmvbhash(image(waves), 16);
    expect(same).toHaveLength(64);
    expect(bmvbhash(image(waves), 16)).toBe(same);
    const links = await PrintComparer.links([item(1), item(2)], [{ hash: same, tiny: tiny(1) }, { hash: bmvbhash(image(rings), 16), tiny: tiny(1) }], signal, () => {});
    expect(links).toEqual([]);
  });
});

describe("DuplicateGrouper", () => {
  const index = (photos: DuplicatePhoto[], links: [number, number, number][]): Pick<DuplicateIndex, "photos" | "links"> => ({ photos, links: links.map(([a, b, similarity]) => ({ a, b, similarity })) });

  it("ranks the most pixels first, then the largest file, then a location, then the oldest", () => {
    const rank = (ps: DuplicatePhoto[]) => [...ps].sort(DuplicateGrouper.compare).map((p) => p.item.mediaKey);
    expect(rank([photo(1, { width: 1000, height: 750 }), photo(2)])[0]).toBe(item(2).mediaKey);
    expect(rank([photo(1, {}, 10), photo(2, {}, 20)])[0]).toBe(item(2).mediaKey);
    expect(rank([photo(1), photo(2, { location: { latitude: 1, longitude: 2 } })])[0]).toBe(item(2).mediaKey);
    expect(rank([photo(2), photo(1)])[0]).toBe(item(1).mediaKey);
    expect(rank([photo(1, { width: 9000, height: 9000, editable: false }), photo(2)])[0]).toBe(item(2).mediaKey);
  });

  it("explains the choice", () => {
    const g = DuplicateGrouper.groups(index([photo(1, { width: 1000, height: 750 }), photo(2)], [[0, 1, 100]]), 100)[0]!;
    expect(g.members[0]!.photo.item.mediaKey).toBe(item(2).mediaKey);
    expect(g.reason).toBe("Highest resolution: 4,000 × 3,000");
    const sized = DuplicateGrouper.groups(index([photo(1, {}, 5), photo(2, {}, 9)], [[0, 1, 100]]), 100)[0]!;
    expect(sized.reason).toBe("Largest file");
  });

  it("regroups with the slider", () => {
    const i = index([photo(1), photo(2), photo(3)], [[0, 1, 100], [0, 2, 80]]);
    expect(DuplicateGrouper.groups(i, 100)[0]!.members).toHaveLength(2);
    expect(DuplicateGrouper.groups(i, 80)[0]!.members).toHaveLength(3);
    expect(DuplicateGrouper.groups(i, 100)).toHaveLength(1);
  });

  it("never chains: A like B and B like C does not put A with C", () => {
    const groups = DuplicateGrouper.groups(index([photo(1), photo(2), photo(3)], [[0, 1, 90], [1, 2, 90]]), 90);
    const keys = groups.map((g) => g.members.map((m) => m.photo.item.mediaKey));
    expect(keys).toEqual([[item(1).mediaKey, item(2).mediaKey]]); // 3 has nobody left to match
  });

  it("leaves out what is already in the trash", () => {
    const i = index([photo(1), photo(2), photo(3)], [[0, 1, 100], [0, 2, 100]]);
    expect(DuplicateGrouper.groups(i, 100, new Set([item(2).dedupKey]))[0]!.members).toHaveLength(2);
    expect(DuplicateGrouper.groups(i, 100, new Set([item(2).dedupKey, item(3).dedupKey]))).toEqual([]);
  });
});

describe("DuplicatePlans", () => {
  const group = DuplicateGrouper.groups({ photos: [photo(1), photo(2), photo(3, { editable: false })], links: [{ a: 0, b: 1, similarity: 100 }, { a: 0, b: 2, similarity: 100 }] }, 100)[0]!;

  it("keeps the best and trashes the rest, never someone else's photo", () => {
    const plan = DuplicatePlans.plan(group, {})!;
    expect(plan.keep.mediaKey).toBe(item(1).mediaKey);
    expect(plan.trash.map((i) => i.mediaKey)).toEqual([item(2).mediaKey]);
  });

  it("follows the user's choice", () => {
    const plan = DuplicatePlans.plan(group, { [item(1).dedupKey]: "trash", [item(2).dedupKey]: "keep" })!;
    expect(plan.keep.mediaKey).toBe(item(2).mediaKey);
    expect(plan.trash.map((i) => i.mediaKey)).toEqual([item(1).mediaKey]);
  });

  it("has no plan when nothing goes or nothing would stay", () => {
    expect(DuplicatePlans.plan(group, { [item(2).dedupKey]: "keep" })).toBeNull();
    const two = DuplicateGrouper.groups({ photos: [photo(1), photo(2)], links: [{ a: 0, b: 1, similarity: 100 }] }, 100)[0]!;
    expect(DuplicatePlans.plan(two, { [item(1).dedupKey]: "trash", [item(2).dedupKey]: "trash" })).toBeNull();
  });
});

describe("DuplicatesDetector", () => {
  const sizes = { readItemInfo: async (keys: string[]) => keys.map((mediaKey) => ({ mediaKey, fileName: null, takenAtMs: 0, timezoneOffsetMs: 0, sizeBytes: 7 })) };
  const printer = (values: Map<string, PhotoPrint>) => {
    const read: string[] = [];
    return { read, print: async (i: LibraryItem) => { read.push(i.mediaKey); const p = values.get(i.mediaKey); if (!p) throw new PixError(ErrorCode.MediaFetchFailed, "gone"); return p; } };
  };

  it("reads each photo once, reuses it later, and reports only photos that match", async () => {
    const items = [item(1), item(2), item(3)];
    const values = new Map([[items[0]!.mediaKey, print(0)], [items[1]!.mediaKey, print(0)], [items[2]!.mediaKey, print(200)]]);
    const p = printer(values);
    const cache = memoryCache();
    const found: DuplicateIndex[] = [];
    const first = await new DuplicatesDetector(p, sizes, cache).analyze(items, ctx(), (f) => found.push(f));
    expect(first.photosChecked).toBe(3);
    expect(found[0]!.photos.map((x) => [x.item.mediaKey, x.sizeBytes])).toEqual([[items[0]!.mediaKey, 7], [items[1]!.mediaKey, 7]]);
    expect(found[0]!.links).toEqual([{ a: 0, b: 1, similarity: 100 }]);

    const second = await new DuplicatesDetector(p, sizes, cache).analyze(items, ctx(), () => {});
    expect(second.photosReused).toBe(3);
    expect(p.read).toHaveLength(3);
    await new DuplicatesDetector(p, sizes, cache, true).analyze(items, ctx(), () => {});
    expect(p.read).toHaveLength(6); // Re-check all
  });

  it("skips videos and counts a photo it cannot read, without stopping", async () => {
    const items = [item(1), item(2), item(3, { type: "video" })];
    const p = printer(new Map([[items[0]!.mediaKey, print(0)]]));
    const r = await new DuplicatesDetector(p, sizes, memoryCache()).analyze(items, ctx(), () => {});
    expect(p.read).not.toContain(items[2]!.mediaKey);
    expect(r.failures[0]!.message).toBe("1 photo could not be read for duplicates");
  });

  it("stops on a problem that would hit everything", async () => {
    const r = new DuplicatesDetector({ print: async () => { throw new PixError(ErrorCode.AccountMismatch, "other"); } }, sizes, memoryCache()).analyze([item(1)], ctx(), () => {});
    await expect(r).rejects.toMatchObject({ code: ErrorCode.AccountMismatch });
  });

  it("still ranks when file sizes cannot be read", async () => {
    const items = [item(1), item(2)];
    const found: DuplicateIndex[] = [];
    const noSizes = { readItemInfo: async () => { throw new PixError(ErrorCode.RpcHttpError, "busy"); } };
    await new DuplicatesDetector(printer(new Map([[items[0]!.mediaKey, print(0)], [items[1]!.mediaKey, print(0)]])), noSizes, memoryCache()).analyze(items, ctx(), (f) => found.push(f));
    expect(found[0]!.photos[0]!.sizeBytes).toBeNull();
  });
});

describe("DuplicateTrasher", () => {
  const album = (key: string, shared = false): AlbumRef => ({ mediaKey: key, title: key, shared });
  class FakeGoogle {
    readonly details = new Map<string, ItemDetails>();
    readonly trashed = new Set<string>();
    readonly log: string[] = [];
    refuseAlbums = false;

    add(i: LibraryItem, albums: AlbumRef[] = [], description = ""): void {
      this.details.set(i.mediaKey, { mediaKey: i.mediaKey, dedupKey: i.dedupKey, description, albums, location: null, camera: null });
    }

    async getItemDetails(k: string): Promise<ItemDetails> {
      return this.details.get(k)!;
    }

    async addToAlbum(keys: string[], a: AlbumRef): Promise<void> {
      this.log.push(`album:${a.mediaKey}`);
      if (!this.refuseAlbums) for (const k of keys) { const d = this.details.get(k)!; this.details.set(k, { ...d, albums: [...d.albums, a] }); }
    }

    async setDescription(dedup: string, text: string): Promise<void> {
      this.log.push("description");
      const d = [...this.details.values()].find((x) => x.dedupKey === dedup)!;
      this.details.set(d.mediaKey, { ...d, description: text });
    }

    async moveToTrash(keys: string[]): Promise<void> {
      this.log.push("trash");
      for (const k of keys) this.trashed.add(k);
    }

    async listTrash(): Promise<Page<string>> {
      return { items: [...this.trashed], next: null };
    }
  }
  const trasher = (g: FakeGoogle) => new DuplicateTrasher(g, new TrashMover(g, async () => {}));
  const [keep, copy, other] = [item(1), item(2), item(3)];

  it("gives the kept photo the copies' albums and description before anything is trashed", async () => {
    const g = new FakeGoogle();
    g.add(keep, [album("A1")]);
    g.add(copy, [album("A1"), album("A2")], "Harbour");
    const moved: string[] = [];
    const r = await trasher(g).run([{ keep, trash: [copy] }], () => {}, (k) => void moved.push(...k));
    expect(g.log).toEqual(["album:A2", "description", "trash"]);
    expect(g.details.get(keep.mediaKey)!.description).toBe("Harbour");
    expect(moved).toEqual([copy.dedupKey]);
    expect(r).toEqual({ skippedShared: 0, problems: [] });
  });

  it("does not touch a description the kept photo already has", async () => {
    const g = new FakeGoogle();
    g.add(keep, [], "Mine");
    g.add(copy, [], "Theirs");
    await trasher(g).run([{ keep, trash: [copy] }], () => {}, () => {});
    expect(g.details.get(keep.mediaKey)!.description).toBe("Mine");
    expect(g.log).toEqual(["trash"]);
  });

  it("leaves a group alone when a copy is in a shared album, and still does the others", async () => {
    const g = new FakeGoogle();
    g.add(keep);
    g.add(copy, [album("S", true)]);
    g.add(other);
    const keep2 = item(4);
    g.add(keep2);
    const r = await trasher(g).run([{ keep, trash: [copy] }, { keep: keep2, trash: [other] }], () => {}, () => {});
    expect(r.skippedShared).toBe(1);
    expect([...g.trashed]).toEqual([other.dedupKey]);
  });

  it("leaves a group alone when the album did not stick: the read-back decides", async () => {
    const g = new FakeGoogle();
    g.add(keep);
    g.add(copy, [album("A2")]);
    g.refuseAlbums = true;
    const r = await trasher(g).run([{ keep, trash: [copy] }], () => {}, () => {});
    expect(r.problems[0]!.code).toBe(ErrorCode.OriginalsKept);
    expect(g.trashed.size).toBe(0);
    expect(g.log).not.toContain("trash");
  });

  it("stops everything on a problem that would hit every group", async () => {
    const g = new FakeGoogle();
    g.getItemDetails = async () => { throw new PixError(ErrorCode.AccountMismatch, "other account"); };
    await expect(trasher(g).run([{ keep, trash: [copy] }], () => {}, () => {})).rejects.toMatchObject({ code: ErrorCode.AccountMismatch });
    expect(g.trashed.size).toBe(0);
  });
});
