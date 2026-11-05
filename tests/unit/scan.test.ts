import { describe, expect, it } from "vitest";
import type { LibraryItem, MediaItemInfo } from "../../src/domain/types.js";
import { MetadataInheritance } from "../../src/extension/editor/panorama/panorama-pipeline.js";
import { MockPhotosAdapter } from "../../src/gphotos/mock-adapter.js";
import { ListingParser } from "../../src/gphotos/protocol/rpcs.js";
import { LibraryCatalog, type CatalogSource } from "../../src/scan/library-catalog.js";
import { LibraryScanner } from "../../src/scan/library-scanner.js";
import { CONTENT_URL } from "../../src/gphotos/adapter.js";
import { PanoramaDetector, ScanConcurrency, TimeSequenceGrouper, type OverlapChecker, type OverlapGroup, type PanoramaCandidate, type SavedSequence, PanoramaPlausibility } from "../../src/scan/panorama-detector.js";
import type { ScanCache } from "../../src/scan/scan-cache.js";
import { ScanScopes } from "../../src/scan/scan-scope.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";

const T0 = Date.UTC(2025, 5, 1, 12, 0, 0);
const key = (n: number) => `AF1QipITEM${String(n).padStart(8, "0")}`;

function item(n: number, secondsAfterT0: number, over: Partial<LibraryItem> = {}): LibraryItem {
  return { mediaKey: key(n), dedupKey: `dedup${n}xxxxxxxx`, type: "photo", width: 4000, height: 3000, takenAtMs: T0 + secondsAfterT0 * 1000, timezoneOffsetMs: 3_600_000, baseUrl: `https://lh3.googleusercontent.com/item${n}`, location: null, ...over };
}

function info(i: LibraryItem): MediaItemInfo {
  return { ref: { accountEmail: "a@b.com", mediaKey: i.mediaKey }, dedupKey: i.dedupKey, type: i.type, width: i.width, height: i.height, takenAtMs: i.takenAtMs, timezoneOffsetMs: i.timezoneOffsetMs, baseUrl: i.baseUrl, fileName: `IMG_${i.mediaKey}.jpg`, sizeBytes: 1 };
}

/** CatalogSource over the mock adapter (3 items per page, so paging is exercised). */
function catalogOver(items: LibraryItem[], albums: Record<string, number[]> = {}): { source: CatalogSource; mock: MockPhotosAdapter } {
  const mock = new MockPhotosAdapter({ email: "a@b.com", gaiaId: null, authUserIndex: 0 });
  for (const i of items) mock.addItem(info(i));
  for (const [albumKey, ns] of Object.entries(albums)) mock.albumItems.set(albumKey, ns.map(key));
  const source: CatalogSource = {
    listLibrary: (page, startMs) => mock.listLibrary({ page, startMs }),
    listAlbumItems: (albumKey, page) => mock.listAlbumItems(albumKey, page),
    getItem: (k) => mock.getItem(k),
  };
  return { source, mock };
}

const signal = new AbortController().signal;

describe("TimeSequenceGrouper", () => {
  it("groups same-size photos taken seconds apart and splits on gaps, size changes and videos", () => {
    const items = [
      item(1, 0), item(2, 4), item(3, 9), // a pan
      item(4, 120), // alone
      item(5, 125, { width: 1080, height: 1920 }), // other camera/size
      item(6, 300, { width: 3000, height: 4000 }), item(7, 303), // rotated dims still count as the same size
      item(8, 305, { type: "video" }),
      item(9, 400, { width: 12000, height: 3000 }), item(10, 402, { width: 12000, height: 3000 }), // already panoramas
    ];
    expect(TimeSequenceGrouper.group(items).map((r) => r.map((i) => i.mediaKey))).toEqual([[key(1), key(2), key(3)], [key(6), key(7)]]);
  });

  it("splits runs longer than the panorama limit at their largest gap", () => {
    const run = Array.from({ length: 50 }, (_, i) => item(i, i * 2 + (i >= 30 ? 20 : 0)));
    const groups = TimeSequenceGrouper.group(run);
    expect(groups.map((g) => g.length)).toEqual([30, 20]);
  });
});

describe("LibraryCatalog", () => {
  const items = Array.from({ length: 8 }, (_, i) => item(i, i * 3600));

  it("lists a date range across pages and stops at older items", async () => {
    const { source } = catalogOver(items);
    const got = await new LibraryCatalog(source).collect({ kind: "dateRange", fromMs: T0 + 2 * 3600_000, toMs: T0 + 5 * 3600_000 }, () => {}, signal);
    expect(got.map((i) => i.mediaKey)).toEqual([key(5), key(4), key(3), key(2)]);
  });

  it("lists the whole library, an album and a selection", async () => {
    const { source } = catalogOver(items, { AF1QipALBUM0000001: [1, 2] });
    const catalog = new LibraryCatalog(source);
    expect(await catalog.collect({ kind: "library" }, () => {}, signal)).toHaveLength(8);
    expect((await catalog.collect({ kind: "album", album: { mediaKey: "AF1QipALBUM0000001", title: "Trip", shared: false } }, () => {}, signal)).map((i) => i.mediaKey)).toEqual([key(1), key(2)]);
    expect((await catalog.collect({ kind: "selection", mediaKeys: [key(7), key(0)] }, () => {}, signal)).map((i) => i.mediaKey)).toEqual([key(7), key(0)]);
  });

  it("stops when cancelled", async () => {
    const { source } = catalogOver(items);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(new LibraryCatalog(source).collect({ kind: "library" }, () => {}, ctrl.signal)).rejects.toMatchObject({ code: ErrorCode.Cancelled });
  });

  it("rejects empty selections and reversed date ranges", () => {
    expect(() => ScanScopes.validate({ kind: "selection", mediaKeys: [] })).toThrow();
    expect(() => ScanScopes.validate({ kind: "dateRange", fromMs: 10, toMs: 5 })).toThrow();
  });
});

describe("PanoramaDetector + LibraryScanner", () => {
  it("emits one candidate per stitched group, showing only its photos, and recognises earlier saves", async () => {
    // Paragraph: a 4-shot sequence of which the engine stitches two; one shot is far away in time.
    const items = [item(1, 0), item(2, 3), item(3, 5), item(4, 8), item(9, 5000)];
    const checker: OverlapChecker = {
      check: async (seq) => {
        expect(seq.map((i) => i.mediaKey)).toEqual([key(1), key(2), key(3), key(4)]);
        return [{ mediaKeys: [key(1), key(2)], preview: { image: new Blob(["p"]), width: 10, height: 5, motion: "rotate" }, thumbs: {} }];
      },
    };
    const detector = new PanoramaDetector(checker, (group) => (group.some((i) => i.mediaKey === key(1)) ? { webUrl: "mock://done" } : null), memoryCache());
    const { source } = catalogOver(items);
    const found: PanoramaCandidate[] = [];
    const steps: string[] = [];
    const summary = await new LibraryScanner(new LibraryCatalog(source), [detector]).run({ kind: "library" }, { signal, progress: (s) => steps.push(s) }, (f) => found.push(f as PanoramaCandidate));

    // Paragraph: one finding with its items and the earlier save.
    expect(summary).toMatchObject({ itemsListed: 5, photos: 5, findings: 1 });
    expect(found[0]!.mediaKeys).toEqual([key(1), key(2)]);
    expect(found[0]!.items.map((i) => i.mediaKey)).toEqual([key(1), key(2)]);
    expect(found[0]!.alreadyMade).toEqual({ webUrl: "mock://done" });
    expect(steps.some((s) => s.startsWith("Listing photos"))).toBe(true);
  });
});

function memoryCache(): ScanCache<SavedSequence> & { map: Map<string, SavedSequence> } {
  const map = new Map<string, SavedSequence>();
  return { map, get: async (s) => map.get(s) ?? null, put: async (s, v) => void map.set(s, v) };
}

describe("PanoramaPlausibility", () => {
  const used = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("accepts stitched panoramas, measured on OpenCV's public samples", () => {
    expect(PanoramaPlausibility.holds({ viewGain: 2.33, shortSide: 0.85, used: used(6) })).toBe(true); // boat
    expect(PanoramaPlausibility.holds({ viewGain: 2.66, shortSide: 1.36, used: used(6) })).toBe(true); // budapest
    expect(PanoramaPlausibility.holds({ viewGain: 2.14, shortSide: 1.35, used: used(4) })).toBe(true); // newspaper
  });

  it("refuses what real bursts stitched into", () => {
    expect(PanoramaPlausibility.holds({ viewGain: 1.15, shortSide: 0.84, used: used(2) })).toBe(false); // barely more than one photo
    expect(PanoramaPlausibility.holds({ viewGain: 8.88, shortSide: 0.98, used: used(2) })).toBe(false); // a strip longer than its photos can be
    expect(PanoramaPlausibility.holds({ viewGain: 0.43, shortSide: 0.63, used: used(2) })).toBe(false); // cropped to less than one photo
    expect(PanoramaPlausibility.holds({ viewGain: 2, shortSide: 0.3, used: used(4) })).toBe(false); // a thin sliver
    expect(PanoramaPlausibility.holds({ viewGain: 2, shortSide: 1, used: used(1) })).toBe(false); // one photo left
  });
});

describe("PanoramaDetector saved results", () => {
  const seq = [item(1, 0), item(2, 3), item(3, 6)];
  const later = [item(4, 5000), item(5, 5003)];
  const preview = { image: new Blob(["p"]), width: 10, height: 5, motion: "rotate" as const };
  const groupOf = (s: readonly LibraryItem[]): OverlapGroup => ({ mediaKeys: s.map((i) => i.mediaKey), preview, thumbs: Object.fromEntries(s.map((i) => [i.mediaKey, new Blob(["t"])])) });
  const ctx = (steps: string[] = []) => ({ signal, progress: (s: string) => void steps.push(s) });
  const none = () => null;

  it("checks each sequence once; later scans only check what is new", async () => {
    // Paragraph: first scan checks everything and saves it.
    const cache = memoryCache();
    let checks = 0;
    const checker: OverlapChecker = { check: async (s) => { checks++; return [groupOf(s)]; } };
    const first: PanoramaCandidate[] = [];
    const a = await new PanoramaDetector(checker, none, cache).analyze(seq, ctx(), (f) => first.push(f));
    expect(a).toEqual({ photosReused: 0, photosChecked: 3, failures: [] });
    expect(checks).toBe(1);

    // Paragraph: second scan answers it from the cache, with preview and thumbnails, and checks only the new sequence.
    const second: PanoramaCandidate[] = [];
    const b = await new PanoramaDetector(checker, none, cache).analyze([...seq, ...later], ctx(), (f) => second.push(f));
    expect(b).toEqual({ photosReused: 3, photosChecked: 2, failures: [] });
    expect(checks).toBe(2);
    expect(second.map((c) => c.items.length)).toEqual([3, 2]);
    expect(second[0]!.preview.width).toBe(10);
    expect(Object.keys(second[0]!.thumbs)).toEqual(seq.map((i) => i.mediaKey));
  });

  it("matches saved results across views (album item keys differ, dedup keys do not)", async () => {
    const cache = memoryCache();
    await new PanoramaDetector({ check: async (s) => [groupOf(s)] }, none, cache).analyze(seq, ctx(), () => {});
    const albumView = seq.map((i, n) => ({ ...i, mediaKey: `AF1QipALBUMVIEW00${n}` }));
    const found: PanoramaCandidate[] = [];
    const never: OverlapChecker = { check: async () => { throw new Error("must not check"); } };
    await new PanoramaDetector(never, none, cache).analyze(albumView, ctx(), (f) => found.push(f));
    expect(found[0]!.mediaKeys).toEqual(albumView.map((i) => i.mediaKey));
    expect(Object.keys(found[0]!.thumbs)).toEqual(albumView.map((i) => i.mediaKey));
  });

  it("checks a sequence again when a photo was added, or when asked to", async () => {
    const cache = memoryCache();
    let checks = 0;
    const checker: OverlapChecker = { check: async (s) => { checks++; return [groupOf(s)]; } };
    await new PanoramaDetector(checker, none, cache).analyze(seq, ctx(), () => {});
    await new PanoramaDetector(checker, none, cache).analyze([...seq, item(9, 8)], ctx(), () => {});
    expect(checks).toBe(2);
    await new PanoramaDetector(checker, none, cache, true).analyze([...seq, item(9, 8)], ctx(), () => {});
    expect(checks).toBe(3);
  });

  it("remembers sequences with no panorama, but not sequences that failed", async () => {
    const cache = memoryCache();
    await new PanoramaDetector({ check: async () => [] }, none, cache).analyze(seq, ctx(), () => {});
    expect(cache.map.size).toBe(1);
    const failed = memoryCache();
    const r = await new PanoramaDetector({ check: async () => { throw new PixError(ErrorCode.StitchFailed, "OpenCV ran out of memory"); } }, none, failed).analyze(seq, ctx(), () => {});
    expect(failed.map.size).toBe(0);
    expect(r.failures.map((f) => f.message)).toEqual(["OpenCV ran out of memory"]);
  });

  it("keeps going when one sequence fails, and reports it", async () => {
    const checker: OverlapChecker = { check: async (s) => { if (s[0]!.mediaKey === key(1)) throw new PixError(ErrorCode.MediaFetchFailed, "one bad photo"); return [groupOf(s)]; } };
    const found: PanoramaCandidate[] = [];
    const r = await new PanoramaDetector(checker, none, memoryCache()).analyze([...seq, ...later], ctx(), (f) => found.push(f));
    expect(found).toHaveLength(1);
    expect(r.failures.map((f) => f.message)).toEqual(["one bad photo"]);
  });

  it("stops at once on account problems and after repeated failures", async () => {
    const run = (code: ErrorCode, seqs: number) => {
      const items = Array.from({ length: seqs }, (_, n) => [item(n * 10, n * 1000), item(n * 10 + 1, n * 1000 + 3)]).flat();
      let checks = 0;
      const checker: OverlapChecker = { check: async () => { checks++; throw new PixError(code, "nope"); } };
      return { promise: new PanoramaDetector(checker, none, memoryCache()).analyze(items, ctx(), () => {}), checks: () => checks };
    };
    const account = run(ErrorCode.AccountMismatch, 3);
    await expect(account.promise).rejects.toMatchObject({ code: ErrorCode.AccountMismatch });
    expect(account.checks()).toBe(1);
    const repeated = run(ErrorCode.MediaFetchFailed, 20);
    await expect(repeated.promise).rejects.toMatchObject({ code: ErrorCode.MediaFetchFailed });
    expect(repeated.checks()).toBe(PanoramaDetector.MAX_FAILURES_IN_A_ROW);
  });
});

describe("PanoramaDetector with several engines", () => {
  const none = () => null;
  const sequence = (start: number) => [item(start, start * 100), item(start + 1, start * 100 + 3)];
  const library = [...sequence(1), ...sequence(10), ...sequence(20), ...sequence(30), ...sequence(40)];
  const ctx = (progress: (done: number | undefined, total: number | undefined) => void = () => {}) => ({ signal: new AbortController().signal, progress: (_s: string, d?: number, t?: number) => progress(d, t) });

  /** A checker that records how many run at once. */
  const engines = (n: number) => {
    const state = { running: 0, most: 0, checked: [] as string[] };
    const one = {
      check: async (s: readonly LibraryItem[]) => {
        state.running++;
        state.most = Math.max(state.most, state.running);
        await new Promise((r) => setTimeout(r, 5));
        state.checked.push(s[0]!.mediaKey);
        state.running--;
        return [];
      },
    };
    return { state, checkers: Array.from({ length: n }, () => one) };
  };

  it("checks sequences side by side, each exactly once, and saves all of them", async () => {
    const { state, checkers } = engines(3);
    const cache = memoryCache();
    const r = await new PanoramaDetector(checkers, none, cache).analyze(library, ctx(), () => {});
    expect(state.most).toBe(3);
    expect([...state.checked].sort()).toEqual([key(1), key(10), key(20), key(30), key(40)].sort());
    expect(r.photosChecked).toBe(10);

    // Paragraph: a later scan, with any number of engines, has nothing left to do.
    const again = engines(1);
    const second = await new PanoramaDetector(again.checkers, none, cache).analyze(library, ctx(), () => {});
    expect(again.state.checked).toEqual([]);
    expect(second.photosReused).toBe(10);
  });

  it("never counts backwards or past the total", async () => {
    const seen: number[] = [];
    const checker = { check: async (_s: readonly LibraryItem[], _a: AbortSignal, on: (f: number) => void) => { on(0.5); await new Promise((r) => setTimeout(r, 2)); on(1); return []; } };
    await new PanoramaDetector([checker, checker], none, memoryCache()).analyze(library, ctx((d, t) => { if (d !== undefined && t === 10) seen.push(d); }), () => {});
    expect(Math.max(...seen)).toBe(10);
    expect(seen.every((d, i) => i === 0 || d >= seen[i - 1]! - 2)).toBe(true);
  });

  it("stops every engine on a problem that would hit everything, and reports it", async () => {
    let calls = 0;
    const checker = { check: async () => { calls++; await new Promise((r) => setTimeout(r, 2)); throw new PixError(ErrorCode.AccountMismatch, "other account"); } };
    await expect(new PanoramaDetector([checker, checker], none, memoryCache()).analyze(library, ctx(), () => {})).rejects.toMatchObject({ code: ErrorCode.AccountMismatch });
    expect(calls).toBe(2);
  });

  it("keeps what finished before a stop, so the next scan continues from there", async () => {
    const cache = memoryCache();
    let calls = 0;
    const checker = { check: async () => { if (++calls === 3) throw new PixError(ErrorCode.Cancelled, "stopped"); return []; } };
    await expect(new PanoramaDetector(checker, none, cache).analyze(library, ctx(), () => {})).rejects.toMatchObject({ code: ErrorCode.Cancelled });
    const rest = engines(1);
    const r = await new PanoramaDetector(rest.checkers, none, cache).analyze(library, ctx(), () => {});
    expect(r.photosReused).toBe(4);
    expect(rest.state.checked).toHaveLength(3);
  });
});

describe("ScanConcurrency", () => {
  it("is bounded by cores and memory", () => {
    expect(ScanConcurrency.engines(20, 32)).toBe(ScanConcurrency.MAX_ENGINES);
    expect(ScanConcurrency.engines(2, 32)).toBe(1);
    expect(ScanConcurrency.engines(4, 32)).toBe(2);
    expect(ScanConcurrency.engines(20, 4)).toBe(1);
    expect(ScanConcurrency.engines(1, undefined)).toBe(1);
  });
});

describe("CONTENT_URL", () => {
  it("accepts Google's image hosts as seen in live listings", () => {
    expect(CONTENT_URL.test("https://photos.fife.usercontent.google.com/pw/AP1GczAbc-_123")).toBe(true);
    expect(CONTENT_URL.test("https://lh3.googleusercontent.com/abc")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const bad of ["https://evil.example/pw/x", "https://usercontent.google.com.evil.example/x", "https://evil.example/.usercontent.google.com/x", "http://photos.fife.usercontent.google.com/pw/x", "https://photos.fife.usercontent.google.com/"]) {
      expect(CONTENT_URL.test(bad)).toBe(false);
    }
  });
});

describe("ScanSession.alreadyMade", () => {
  it("matches earlier saves by dedup key (album views use different media keys)", async () => {
    const { ScanSession } = await import("../../src/extension/scan/scan-session.js");
    const job = { saved: { webUrl: "https://photos.google.com/photo/X" }, usedDedupKeys: [item(1, 0).dedupKey, item(2, 3).dedupKey], usedMediaKeys: ["AF1QipLIBRARYKEY01"], sourceMediaKeys: [] } as never;
    const albumView = [item(1, 0, { mediaKey: "AF1QipALBUMITEMKEY1" }), item(2, 3, { mediaKey: "AF1QipALBUMITEMKEY2" }), item(3, 6)];
    expect(ScanSession.alreadyMade([job], albumView)).toEqual({ webUrl: "https://photos.google.com/photo/X" });
    expect(ScanSession.alreadyMade([job], [item(3, 6), item(4, 9), item(5, 12)])).toBeNull();
  });
});

describe("MetadataInheritance.derive", () => {
  it("takes the earliest date, the first location and description, and every album", () => {
    const ordered = [
      { mediaKey: key(1), takenAtMs: T0, timezoneOffsetMs: 7_200_000 },
      { mediaKey: key(2), takenAtMs: T0 + 3000, timezoneOffsetMs: 7_200_000 },
      { mediaKey: key(3), takenAtMs: T0 + 6000, timezoneOffsetMs: 7_200_000 },
    ];
    const trip = { mediaKey: "AF1QipALBUMTRIP0001", title: "Trip", shared: false };
    const family = { mediaKey: "AF1QipALBUMFAM00001", title: "Family", shared: true };
    const m = MetadataInheritance.derive(ordered, [
      { description: "  ", albums: [trip], location: null },
      { description: "Sunset at the bay", albums: [trip, family], location: { latitude: 1.5, longitude: 2.5 } },
      { description: "other", albums: [], location: { latitude: 9, longitude: 9 } },
    ]);
    expect(m).toEqual({ earliestMediaKey: key(1), takenAtMs: T0, timezoneOffsetMs: 7_200_000, location: { latitude: 1.5, longitude: 2.5 }, description: "Sunset at the bay", albums: [trip, family] });
  });
});

describe("ListingParser (synthetic rows shaped like live lcxiM / Z5xsfc responses)", () => {
  it("parses items with location and video markers, and albums with titles", () => {
    const row = ["AF1QipROW000000001", ["https://lh3.googleusercontent.com/x", 4000, 3000, null, null, null, null, null, [null, null, 1], [1]], T0, "dedupROW0000000001", 3_600_000, T0, null, [[1]], 0, null, null, null, { "129168200": [[null, null, null, null, null, 1], [[515_000_000, -1_250_000], null, null, true, [], 1]] }];
    expect(ListingParser.item("lcxiM", row)).toEqual({ mediaKey: "AF1QipROW000000001", baseUrl: "https://lh3.googleusercontent.com/x", width: 4000, height: 3000, takenAtMs: T0, dedupKey: "dedupROW0000000001", timezoneOffsetMs: 3_600_000, type: "photo", location: { latitude: 51.5, longitude: -0.125 }, editable: true });
    const video = ["AF1QipROW000000002", ["https://lh3.googleusercontent.com/v", 1920, 1080], T0, "dedupROW0000000002", 0, { "76647426": [1000] }];
    expect(ListingParser.item("lcxiM", video)).toMatchObject({ type: "video", location: null });
    const album = ["AF1QipALBUMROW0001", ["https://lh3.googleusercontent.com/a", 1, 1], null, null, null, null, ["owner"], [[1]], { "72930366": [1, "Holiday", [], 12, null] }];
    expect(ListingParser.album("Z5xsfc", album)).toEqual({ mediaKey: "AF1QipALBUMROW0001", title: "Holiday", shared: false });
  });

  it("fails loudly when a listing row loses a required field", () => {
    expect(() => ListingParser.item("lcxiM", ["AF1QipROW000000003", null, T0])).toThrow(expect.objectContaining({ code: ErrorCode.RpcUnexpectedShape }));
  });
});
