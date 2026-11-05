import { afterEach, describe, expect, it, vi } from "vitest";
import type { DateChange, ItemFileInfo, LibraryItem } from "../../src/domain/types.js";
import { FormatStore } from "../../src/extension/storage/format-store.js";
import { DateCorrection, DateFixApplier, FilenameDateDetector, type DateFixFinding, type PlannedDate } from "../../src/scan/date-fix.js";
import { FilenameFormat, FilenameFormats } from "../../src/scan/filename-format.js";
import type { ScanCache } from "../../src/scan/scan-cache.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";

const parse = (mask: string, name: string, utc = false) => new FilenameFormat({ mask, utc }).parse(name, 2026);
const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString().slice(0, 19));

describe("FilenameFormat", () => {
  it("reads the format from the request: IMG-yyyymmdd.*", () => {
    const stamp = parse("IMG-yyyymmdd.*", "IMG-20240328.jpg");
    expect(iso(stamp?.localMs)).toBe("2024-03-28T00:00:00");
    expect(stamp?.hasTime).toBe(false);
    expect(parse("IMG-yyyymmdd.*", "img-20240328.MP4")).not.toBeNull(); // case does not matter
    expect(parse("IMG-yyyymmdd.*", "IMG-20240328-WA0001.jpg")).toBeNull(); // the mask covers the whole name
  });

  it("tells months from minutes by position", () => {
    expect(iso(parse("yyyymmdd_hhmmss.*", "20190512_143022.jpg")?.localMs)).toBe("2019-05-12T14:30:22");
    expect(iso(parse("hh-mm_dd-mm-yyyy.*", "14-30_12-05-2019.jpg")?.localMs)).toBe("2019-05-12T14:30:00");
    expect(iso(parse("HOLIDAY_dd-mm-yyyy_*.*", "HOLIDAY_12-05-2018_beach.jpg")?.localMs)).toBe("2018-05-12T00:00:00");
    expect(iso(parse("yyyyMMdd_HHmmss.*", "20190512_143022.jpg")?.localMs)).toBe("2019-05-12T14:30:22");
  });

  it("does not let * and ? translate each other (it once missed every plain camera name)", () => {
    expect(parse("*yyyymmdd?hhmmss*.*", "20190512_143022.jpg")).not.toBeNull();
    expect(parse("*yyyymmdd?hhmmss*.*", "20190512_143022~2.jpg")).not.toBeNull();
    expect(parse("*yyyymmdd?hhmmss*.*", "Screenshot_20190512-143022.png")).not.toBeNull();
    expect(parse("a?c_yyyymmdd.*", "abc_20190512.jpg")).not.toBeNull();
    expect(parse("a?c_yyyymmdd.*", "ac_20190512.jpg")).toBeNull();
  });

  it("treats date letters inside words as text", () => {
    expect(parse("Message_yyyymmdd.*", "Message_20190512.jpg")).not.toBeNull();
    expect(parse("Summer-yyyy-mm-dd.*", "SUMMER-2019-05-12.jpg")).not.toBeNull();
    expect(parse("IMGyyyymmdd*.*", "IMG20240328(1)~2.jpg")).not.toBeNull();
  });

  it("escapes everything else, so a mask can never act as a regular expression", () => {
    expect(parse("(yyyy)[mm]{dd}.+.*", "(2019)[05]{12}.+.jpg")).not.toBeNull();
    expect(parse("yyyy.mm.dd.jpg", "2019x05x12xjpg")).toBeNull();
  });

  it("refuses digits that are not a date, and years out of range", () => {
    expect(parse("yyyymmdd.*", "20191312.jpg")).toBeNull();
    expect(parse("yyyymmdd.*", "20190231.jpg")).toBeNull();
    expect(parse("yyyymmdd_hhmmss.*", "20190512_250000.jpg")).toBeNull();
    expect(parse("yyyymmdd.*", "18990512.jpg")).toBeNull();
    expect(parse("yyyymmdd.*", "20280101.jpg")).toBeNull();
    expect(parse("*yyyymmdd.*", "120190512.jpg")).toBeNull(); // part of a longer number
  });

  it("explains masks it cannot use", () => {
    const message = (mask: string) => { try { new FilenameFormat({ mask, utc: false }); return null; } catch (e) { return (e as PixError).message; } };
    expect(message("")).toBe("Enter a format.");
    expect(message("IMG-*.*")).toBe("Needs yyyy, mm and dd.");
    expect(message("yyyymm.*")).toBe("Needs yyyy, mm and dd.");
    expect(message("yyyymmdd_hh.*")).toBe("A time needs both hh and mm.");
    expect(message("yyyyddmm_mm.*")).toContain("appears twice");
  });
});

describe("FilenameFormats defaults", () => {
  const formats = new FilenameFormats(FilenameFormats.DEFAULTS);

  it.each([
    ["IMG-20190512-WA0001.jpg", "*-yyyymmdd-WA*.*", false],
    ["VID-20190512-WA0003.mp4", "*-yyyymmdd-WA*.*", false],
    ["PXL_20190512_143022123.jpg", "PXL_yyyymmdd_hhmmss*.*", true],
    ["IMG_20190512_143022.jpg", "*yyyymmdd?hhmmss*.*", true],
    ["20190512_143022.jpg", "*yyyymmdd?hhmmss*.*", true],
    ["Screenshot_20190512-143022.png", "*yyyymmdd?hhmmss*.*", true],
    ["20190512143022.jpg", "*yyyymmddhhmmss*.*", true],
    ["Screenshot_2019-05-12-14-30-22.png", "*yyyy-mm-dd?hh?mm?ss*.*", true],
    ["photo_2019-05-12_14-30-22.jpg", "*yyyy-mm-dd?hh?mm?ss*.*", true],
    ["signal-2019-05-12-143022.jpg", "*yyyy-mm-dd-hhmmss*.*", true],
    ["WhatsApp Image 2019-05-12 at 14.30.22.jpeg", "*yyyy-mm-dd at hh.mm.ss*.*", true],
    ["2022-12-02(21)~2.jpg", "yyyy-mm-dd*.*", false],
  ])("%s", (name, mask, hasTime) => {
    expect(formats.parse(name)).toMatchObject({ mask, hasTime });
  });

  it("tries formats with a time first, whatever the list's order", () => {
    const reversed = new FilenameFormats([{ mask: "yyyy-mm-dd*.*", utc: false }, { mask: "yyyy-mm-dd?hh?mm?ss*.*", utc: false }]);
    expect(reversed.parse("2019-05-12_14-30-22.jpg")?.hasTime).toBe(true);
  });

  it("marks Pixel names as UTC", () => {
    expect(formats.parse("PXL_20190512_143022123.jpg")?.utc).toBe(true);
  });
});

describe("DateCorrection", () => {
  const HOUR = 3_600_000;
  const on = (iso: string, offsetHours = 3) => ({ takenAtMs: Date.parse(`${iso}Z`) - offsetHours * HOUR, timezoneOffsetMs: offsetHours * HOUR });
  const stamp = (name: string, mask: string, utc = false) => parse(mask, name, utc)!;

  it("date only: changes the day, keeps the time of day on the photo's clock", () => {
    const item = on("2024-06-01T15:45:10");
    const target = DateCorrection.target(item, stamp("IMG-20190512.jpg", "IMG-yyyymmdd.*"))!;
    expect(iso(target + item.timezoneOffsetMs)).toBe("2019-05-12T15:45:10");
    expect(DateCorrection.target(on("2019-05-12T23:59:00"), stamp("IMG-20190512.jpg", "IMG-yyyymmdd.*"))).toBeNull();
  });

  it("with a time: reads it on the photo's clock, within a tolerance", () => {
    const name = stamp("20190512_143022.jpg", "yyyymmdd_hhmmss.*");
    expect(DateCorrection.target(on("2019-05-12T14:30:22"), name)).toBeNull();
    expect(DateCorrection.target(on("2019-05-12T14:32:00"), name)).toBeNull(); // 98 s
    const item = on("2019-05-12T15:30:22");
    expect(iso(DateCorrection.target(item, name)! + item.timezoneOffsetMs)).toBe("2019-05-12T14:30:22");
  });

  it("UTC names map directly, whatever the photo's offset", () => {
    const name = stamp("PXL_20190512_143022.jpg", "PXL_yyyymmdd_hhmmss*.*", true);
    expect(iso(DateCorrection.target(on("2020-01-01T00:00:00"), name)!)).toBe("2019-05-12T14:30:22");
    expect(DateCorrection.target({ takenAtMs: Date.parse("2019-05-12T14:30:22Z"), timezoneOffsetMs: 3 * HOUR }, name)).toBeNull();
  });
});

function item(n: number, over: Partial<LibraryItem> = {}): LibraryItem {
  return { mediaKey: `AF1QipITEM${String(n).padStart(8, "0")}`, dedupKey: `dedupITEM${n}`, type: "photo", width: 10, height: 10, takenAtMs: Date.UTC(2024, 5, 1, 12), timezoneOffsetMs: 0, baseUrl: "https://x", location: null, ...over };
}

function memory(): ScanCache<string> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, put: async (k, v) => void map.set(k, v) };
}

describe("FilenameDateDetector", () => {
  const ctx = { signal: new AbortController().signal, progress: () => {} };
  const formats = new FilenameFormats([{ mask: "IMG-yyyymmdd*.*", utc: false }]);
  const info = (i: LibraryItem, fileName: string | null): ItemFileInfo => ({ mediaKey: i.mediaKey, fileName, takenAtMs: i.takenAtMs, timezoneOffsetMs: 0 });

  async function run(items: LibraryItem[], names: Map<string, string | null>, cache = memory()) {
    const reads: string[][] = [];
    const found: DateFixFinding[] = [];
    const source = { readItemInfo: async (keys: string[]) => { reads.push(keys); return items.filter((i) => keys.includes(i.mediaKey) && names.has(i.mediaKey)).map((i) => info(i, names.get(i.mediaKey)!)); } };
    const stats = await new FilenameDateDetector(source, formats, cache).analyze(items, ctx, (f) => found.push(f));
    return { reads, found, stats, cache };
  }

  it("finds wrong dates only among names it knows", async () => {
    const items = [item(1), item(2), item(3)];
    const names = new Map<string, string | null>([[items[0]!.mediaKey, "IMG-20190512.jpg"], [items[1]!.mediaKey, "IMG-20240601.jpg"], [items[2]!.mediaKey, "whatever.jpg"]]);
    const { found } = await run(items, names);
    expect(found.map((f) => f.item.mediaKey)).toEqual([items[0]!.mediaKey]);
    expect(found[0]).toMatchObject({ fileName: "IMG-20190512.jpg", mask: "IMG-yyyymmdd*.*" });
  });

  it("reads each file name once, even when an album lists the item under another key", async () => {
    const one = item(1);
    const names = new Map<string, string | null>([[one.mediaKey, "IMG-20190512.jpg"]]);
    const first = await run([one], names);
    expect(first.reads).toHaveLength(1);
    const inAlbum = { ...one, mediaKey: "AF1QipALBUMVIEW000001" };
    const second = await run([inAlbum], new Map(), first.cache);
    expect(second.reads).toHaveLength(0);
    expect(second.stats.photosReused).toBe(1);
    expect(second.found[0]!.item.mediaKey).toBe(inAlbum.mediaKey);
  });

  it("skips items that belong to someone else", async () => {
    const shared = item(1, { editable: false });
    const { found, reads } = await run([shared], new Map([[shared.mediaKey, "IMG-20190512.jpg"]]));
    expect(found).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("reports names it could not read instead of hiding them, and does not save them", async () => {
    const items = [item(1), item(2)];
    const { stats, cache } = await run(items, new Map<string, string | null>([[items[0]!.mediaKey, null]]));
    expect(stats.failures.map((f) => f.message)).toEqual(["2 file names could not be read"]);
    expect(cache.map.size).toBe(0);
  });

  it("goes on after a failed batch, but stops on account problems", async () => {
    const items = Array.from({ length: FilenameDateDetector.NAMES_PER_REQUEST + 1 }, (_, n) => item(n));
    const failing = (code: ErrorCode) => ({ readItemInfo: async () => { throw new PixError(code, "nope"); } });
    const stats = await new FilenameDateDetector(failing(ErrorCode.RpcEnvelopeMissing), formats, memory()).analyze(items, ctx, () => {});
    expect(stats.failures).toHaveLength(2);
    await expect(new FilenameDateDetector(failing(ErrorCode.AccountMismatch), formats, memory()).analyze(items, ctx, () => {})).rejects.toMatchObject({ code: ErrorCode.AccountMismatch });
  });
});

describe("DateFixApplier", () => {
  const plan = (n: number): PlannedDate => ({ mediaKey: `key${n}`, dedupKey: `dedup${n}`, takenAtMs: 1_000_000_000_000 + n * 1000, timezoneOffsetMs: 7_200_000 });

  /** A Google that stores what it is told, except the dedup keys in `refuse`. */
  function google(refuse: string[] = []) {
    const stored = new Map<string, DateChange>();
    const writes: number[] = [];
    return {
      stored, writes,
      setDates: async (changes: DateChange[]) => { writes.push(changes.length); for (const c of changes) if (!refuse.includes(c.dedupKey)) stored.set(c.dedupKey, c); },
      readItemInfo: async (keys: string[]) => keys.flatMap((k) => { const c = stored.get(k.replace("key", "dedup")); return c ? [{ mediaKey: k, fileName: "x.jpg", takenAtMs: c.takenAtMs, timezoneOffsetMs: c.timezoneOffsetMs }] : []; }),
    };
  }

  it("writes in batches and reports what was confirmed", async () => {
    const g = google();
    const applied: string[] = [];
    await new DateFixApplier(g).run(Array.from({ length: 250 }, (_, n) => plan(n)), () => false, (k) => { applied.push(...k); });
    expect(g.writes).toEqual([100, 100, 50]);
    expect(applied).toHaveLength(250);
  });

  it("stops at a date that did not stick, keeping what did", async () => {
    const g = google(["dedup1"]);
    const applied: string[] = [];
    const run = new DateFixApplier(g).run(Array.from({ length: 150 }, (_, n) => plan(n)), () => false, (k) => { applied.push(...k); });
    await expect(run).rejects.toMatchObject({ code: ErrorCode.DateNotApplied });
    expect(applied).toHaveLength(99);
    expect(g.writes).toEqual([100]);
  });

  it("notices a wrong time zone too, and compares whole seconds", async () => {
    const shifted = { ...google(), readItemInfo: async () => [{ mediaKey: "key1", fileName: "x", takenAtMs: plan(1).takenAtMs, timezoneOffsetMs: 0 }] };
    await expect(new DateFixApplier(shifted).run([plan(1)], () => false, () => {})).rejects.toMatchObject({ code: ErrorCode.DateNotApplied });
    const rounded = { ...google(), readItemInfo: async () => [{ mediaKey: "key1", fileName: "x", takenAtMs: plan(1).takenAtMs, timezoneOffsetMs: 7_200_000 }] };
    await new DateFixApplier(rounded).run([{ ...plan(1), takenAtMs: plan(1).takenAtMs + 400 }], () => false, () => {});
  });

  it("stops between batches when asked", async () => {
    const g = google();
    let stop = false;
    await new DateFixApplier(g).run(Array.from({ length: 250 }, (_, n) => plan(n)), () => stop, () => { stop = true; });
    expect(g.writes).toEqual([100]);
  });
});

describe("FormatStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage() {
    const data = new Map<string, unknown>();
    vi.stubGlobal("chrome", { storage: { local: {
      get: async (k: string) => (data.has(k) ? { [k]: data.get(k) } : {}),
      set: async (o: Record<string, unknown>) => { for (const [k, v] of Object.entries(o)) data.set(k, v); },
    } } });
    return data;
  }

  it("starts each account with the defaults and keeps lists apart", async () => {
    stubStorage();
    const first = new FormatStore("first@x.com");
    const second = new FormatStore("second@x.com");
    expect(await first.load()).toEqual(FilenameFormats.DEFAULTS);
    await first.save([{ mask: "IMG-yyyymmdd.*", utc: false }]);
    expect(await first.load()).toEqual([{ mask: "IMG-yyyymmdd.*", utc: false }]);
    expect(await second.load()).toEqual(FilenameFormats.DEFAULTS);
  });

  it("keeps an emptied list empty", async () => {
    stubStorage();
    const store = new FormatStore("a@x.com");
    await store.save([]);
    expect(await store.load()).toEqual([]);
  });

  it("refuses to save an invalid format, and to read a damaged list", async () => {
    const data = stubStorage();
    const store = new FormatStore("a@x.com");
    await expect(store.save([{ mask: "no date here", utc: false }])).rejects.toBeInstanceOf(PixError);
    expect(data.size).toBe(0);
    data.set(`${FormatStore.PREFIX}a@x.com`, "garbage");
    await expect(store.load()).rejects.toMatchObject({ code: ErrorCode.StorageFailed });
  });
});
