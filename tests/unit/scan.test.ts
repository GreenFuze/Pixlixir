import { describe, expect, it } from "vitest";
import type { LibraryItem, MediaItemInfo } from "../../src/domain/types.js";
import { MetadataInheritance } from "../../src/extension/editor/panorama/panorama-pipeline.js";
import { MockPhotosAdapter } from "../../src/gphotos/mock-adapter.js";
import { ListingParser } from "../../src/gphotos/protocol/rpcs.js";
import { LibraryCatalog, type CatalogSource } from "../../src/scan/library-catalog.js";
import { LibraryScanner } from "../../src/scan/library-scanner.js";
import { PanoramaDetector, TimeSequenceGrouper, type OverlapChecker, type PanoramaCandidate } from "../../src/scan/panorama-detector.js";
import { ScanScopes } from "../../src/scan/scan-scope.js";
import { ErrorCode } from "../../src/shared/errors.js";

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
  it("emits one candidate per overlapping group, with retakes set aside and earlier saves recognised", async () => {
    // Paragraph: a 4-shot sequence the engine splits into a 2-view pan (+1 retake); one shot overlaps nothing.
    const items = [item(1, 0), item(2, 3), item(3, 5), item(4, 8), item(9, 5000)];
    const checker: OverlapChecker = {
      check: async (seq) => {
        expect(seq.map((i) => i.mediaKey)).toEqual([key(1), key(2), key(3), key(4)]);
        return [{ mediaKeys: [key(1), key(2)], duplicates: [key(3)], preview: null, previewError: null }];
      },
    };
    const detector = new PanoramaDetector(checker, (group) => (group.some((i) => i.mediaKey === key(1)) ? { webUrl: "mock://done" } : null));
    const { source } = catalogOver(items);
    const found: PanoramaCandidate[] = [];
    const steps: string[] = [];
    const summary = await new LibraryScanner(new LibraryCatalog(source), [detector]).run({ kind: "library" }, { signal, progress: (s) => steps.push(s) }, (f) => found.push(f as PanoramaCandidate));

    // Paragraph: one finding with its items, the retake and the earlier save.
    expect(summary).toMatchObject({ itemsListed: 5, photos: 5, findings: 1 });
    expect(found[0]!.mediaKeys).toEqual([key(1), key(2)]);
    expect(found[0]!.duplicates.map((i) => i.mediaKey)).toEqual([key(3)]);
    expect(found[0]!.alreadyMade).toEqual({ webUrl: "mock://done" });
    expect(steps.some((s) => s.startsWith("Listing photos"))).toBe(true);
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
    expect(ListingParser.item("lcxiM", row)).toEqual({ mediaKey: "AF1QipROW000000001", baseUrl: "https://lh3.googleusercontent.com/x", width: 4000, height: 3000, takenAtMs: T0, dedupKey: "dedupROW0000000001", timezoneOffsetMs: 3_600_000, type: "photo", location: { latitude: 51.5, longitude: -0.125 } });
    const video = ["AF1QipROW000000002", ["https://lh3.googleusercontent.com/v", 1920, 1080], T0, "dedupROW0000000002", 0, { "76647426": [1000] }];
    expect(ListingParser.item("lcxiM", video)).toMatchObject({ type: "video", location: null });
    const album = ["AF1QipALBUMROW0001", ["https://lh3.googleusercontent.com/a", 1, 1], null, null, null, null, ["owner"], [[1]], { "72930366": [1, "Holiday", [], 12, null] }];
    expect(ListingParser.album("Z5xsfc", album)).toEqual({ mediaKey: "AF1QipALBUMROW0001", title: "Holiday", shared: false });
  });

  it("fails loudly when a listing row loses a required field", () => {
    expect(() => ListingParser.item("lcxiM", ["AF1QipROW000000003", null, T0])).toThrow(expect.objectContaining({ code: ErrorCode.RpcUnexpectedShape }));
  });
});
