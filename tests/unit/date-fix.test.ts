import jpeg from "jpeg-js";
import piexif from "piexifjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DateChange, ItemFileInfo, LibraryItem } from "../../src/domain/types.js";
import { FormatStore } from "../../src/extension/storage/format-store.js";
import { DateCorrection, DateFixApplier, ExportDateGuard, FilenameDateDetector, SavedCopyName, type DateFixFinding, type PlannedDate } from "../../src/scan/date-fix.js";
import { FileDetailsReader } from "../../src/scan/file-details.js";
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

/** Files with no details, like a stripped WhatsApp file. */
const noHeads = { fileHead: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) };

/** A small JPEG with a date taken, as the file's own details. */
function jpegTaken(taken: string | null, make: string | null = null): Uint8Array {
  const shell = Buffer.from(jpeg.encode({ width: 2, height: 2, data: Buffer.alloc(16, 128) }, 80).data).toString("binary");
  const dumped = piexif.dump({ "0th": make ? { [piexif.ImageIFD.Make]: make } : {}, Exif: taken ? { [piexif.ExifIFD.DateTimeOriginal]: taken } : {}, GPS: {}, Interop: {}, "1st": {} });
  return Uint8Array.from(piexif.insert(dumped, shell), (c) => c.charCodeAt(0));
}

describe("A file's own details", () => {
  it("reads the date taken, the camera, and nothing from a file without them", () => {
    expect(FileDetailsReader.parse(jpegTaken("2015:03:04 10:20:30", "Canon"))).toMatchObject({ takenLocalMs: Date.UTC(2015, 2, 4, 10, 20, 30), camera: true });
    expect(FileDetailsReader.parse(jpegTaken(null))).toMatchObject({ takenLocalMs: null, camera: false });
    expect(FileDetailsReader.parse(jpegTaken("0000:00:00 00:00:00"))?.takenLocalMs).toBeNull();
    expect(FileDetailsReader.parse(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("allows a day either way for time zones, and says nothing without a date", () => {
    const details = (takenLocalMs: number | null) => ({ takenLocalMs, camera: false, software: null });
    const name = Date.UTC(2022, 11, 2);
    expect(FileDetailsReader.compare(details(name + 30 * 3_600_000), name)).toBe("agrees");
    expect(FileDetailsReader.compare(details(Date.UTC(2015, 0, 1)), name)).toBe("disagrees");
    expect(FileDetailsReader.compare(details(null), name)).toBe("unknown");
    expect(FileDetailsReader.compare(null, name)).toBe("unknown");
  });
});

describe("FilenameDateDetector", () => {
  const ctx = { signal: new AbortController().signal, progress: () => {} };
  const formats = new FilenameFormats([{ mask: "IMG-yyyymmdd*.*", utc: false }]);
  const info = (i: LibraryItem, fileName: string | null): ItemFileInfo => ({ mediaKey: i.mediaKey, fileName, takenAtMs: i.takenAtMs, timezoneOffsetMs: 0 });

  async function run(items: LibraryItem[], names: Map<string, string | null>, cache = memory()) {
    const reads: string[][] = [];
    const found: DateFixFinding[] = [];
    const source = { readItemInfo: async (keys: string[]) => { reads.push(keys); return items.filter((i) => keys.includes(i.mediaKey) && names.has(i.mediaKey)).map((i) => info(i, names.get(i.mediaKey)!)); } };
    const stats = await new FilenameDateDetector(source, formats, cache, noHeads).analyze(items, ctx, (f) => found.push(f));
    return { reads, found, stats, cache };
  }

  it("finds wrong dates only among names it knows", async () => {
    const items = [item(1), item(2), item(3)];
    const names = new Map<string, string | null>([[items[0]!.mediaKey, "IMG-20190512.jpg"], [items[1]!.mediaKey, "IMG-20240601.jpg"], [items[2]!.mediaKey, "whatever.jpg"]]);
    const { found } = await run(items, names);
    expect(found.map((f) => f.item.mediaKey)).toEqual([items[0]!.mediaKey]);
    expect(found[0]).toMatchObject({ fileName: "IMG-20190512.jpg", mask: "IMG-yyyymmdd*.*" });
  });

  it("does not trust a date many files share while their own dates are far apart", async () => {
    // Paragraph: the owner's real case: one export day, dates years apart (2013 to 2022).
    const DAY = 86_400_000;
    const exported = Array.from({ length: ExportDateGuard.MIN_FILES }, (_, n) => item(n + 1, { takenAtMs: Date.UTC(2013 + n * 2, 2, 3, 14, 3) }));
    const whatsapp = Array.from({ length: ExportDateGuard.MIN_FILES }, (_, n) => item(n + 20, { takenAtMs: Date.UTC(2024, 5, 1) + n * DAY }));
    const names = new Map<string, string | null>([...exported.map((i, n) => [i.mediaKey, `IMG-20221202(${n}).jpg`] as [string, string]), ...whatsapp.map((i, n) => [i.mediaKey, `IMG-20190512(${n}).jpg`] as [string, string])]);
    const { found } = await run([...exported, ...whatsapp], names);
    const of = (name: string) => found.filter((f) => f.fileName.includes(name));
    expect(of("20221202").every((f) => f.exportDate)).toBe(true);
    expect(of("20190512").every((f) => !f.exportDate)).toBe(true);
    expect(found.slice(0, ExportDateGuard.MIN_FILES).every((f) => !f.exportDate)).toBe(true); // the likely right ones first
  });

  it("needs enough files: a few photos far apart may really share a name date", async () => {
    const few = Array.from({ length: ExportDateGuard.MIN_FILES - 1 }, (_, n) => item(n + 1, { takenAtMs: Date.UTC(2013 + n * 2, 2, 3) }));
    const { found } = await run(few, new Map(few.map((i, n) => [i.mediaKey, `IMG-20221202(${n}).jpg`] as [string, string])));
    expect(found).toHaveLength(few.length);
    expect(found.some((f) => f.exportDate)).toBe(false);
  });

  it("knows one saved copy by its name alone, as when only that photo is selected", async () => {
    // Paragraph: the owner's real file, alone, so the guard for many files cannot help.
    const copy = item(1, { width: 4000, height: 3000 });
    const dated = new FilenameFormats([{ mask: "yyyy-mm-dd*.*", utc: false }]);
    const found: DateFixFinding[] = [];
    await new FilenameDateDetector({ readItemInfo: async () => [info(copy, "2022-12-02 (3).jpg")] }, dated, memory(), noHeads).analyze([copy], ctx, (f) => found.push(f));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ exportDate: true, copyReason: "name" });
  });

  describe("with the file's own date", () => {
    const dated = new FilenameFormats([{ mask: "*yyyy-mm-dd*.*", utc: false }]);

    /** Scans one file with these details and returns the finding. */
    async function judge(fileName: string, head: Uint8Array, over: Partial<LibraryItem> = {}, heads = { fileHead: async () => head }, cache = memory()) {
      const one = item(1, { width: 4000, height: 3000, ...over });
      const found: DateFixFinding[] = [];
      const stats = await new FilenameDateDetector({ readItemInfo: async () => [info(one, fileName)] }, dated, cache, heads).analyze([one], ctx, (f) => found.push(f));
      return { finding: found[0]!, stats };
    }

    it("makes a copy of a file that disagrees with its name, whatever the name looks like", async () => {
      // Paragraph: an edit with a normal-looking name: nothing but the file could tell.
      const { finding } = await judge("IMG_2019-05-12_edit.jpg", jpegTaken("2012:01:01 10:00:00"));
      expect(finding).toMatchObject({ exportDate: true, copyReason: "file" });
    });

    it("trusts a name its file backs, even a name that looks like a saved copy", async () => {
      const { finding } = await judge("2019-05-12 (3).jpg", jpegTaken("2019:05:12 10:00:00"), { width: 800, height: 600 });
      expect(finding).toMatchObject({ exportDate: false, copyReason: null, fileAgrees: true });
    });

    it("judges a file with no date by its name: WhatsApp and others strip it", async () => {
      expect((await judge("IMG-2019-05-12-WA0001.jpg", jpegTaken(null))).finding).toMatchObject({ exportDate: false, copyReason: null, fileAgrees: false });
      expect((await judge("2019-05-12 (3).jpg", jpegTaken(null))).finding).toMatchObject({ exportDate: true, copyReason: "name" });
    });

    it("never lets the guard mark a file that backs its name", async () => {
      const many = Array.from({ length: ExportDateGuard.MIN_FILES }, (_, n) => item(n + 1, { takenAtMs: Date.UTC(2013 + n * 2, 2, 3) }));
      const found: DateFixFinding[] = [];
      const source = { readItemInfo: async () => many.map((i, n) => info(i, `IMG 2019-05-12 ${n}.jpg`)) };
      await new FilenameDateDetector(source, dated, memory(), { fileHead: async () => jpegTaken("2019:05:12 10:00:00") }).analyze(many, ctx, (f) => found.push(f));
      expect(found.every((f) => !f.exportDate)).toBe(true);
    });

    it("reads a file once, and counts one it cannot read while judging it by its name", async () => {
      // Paragraph: the second scan answers from what was saved, even when the file had no details.
      const cache = memory();
      let reads = 0;
      const counting = { fileHead: async () => { reads++; return jpegTaken(null); } };
      await judge("2019-05-12 x.jpg", new Uint8Array(), {}, counting, cache);
      await judge("2019-05-12 x.jpg", new Uint8Array(), {}, counting, cache);
      expect(reads).toBe(1);

      const failing = { fileHead: async () => { throw new PixError(ErrorCode.MediaFetchFailed, "no"); } };
      const { finding, stats } = await judge("2019-05-12 (3).jpg", new Uint8Array(), {}, failing);
      expect(finding).toMatchObject({ exportDate: true, copyReason: "name" });
      expect(stats.failures[0]!.message).toContain("could not be read for their details");
    });

    it("stops the scan on a failure that means the session is wrong", async () => {
      const wrongAccount = { fileHead: async () => { throw new PixError(ErrorCode.AccountMismatch, "no"); } };
      await expect(judge("2019-05-12.jpg", new Uint8Array(), {}, wrongAccount)).rejects.toMatchObject({ code: ErrorCode.AccountMismatch });
    });

    it("does not try to read a video's file", async () => {
      let reads = 0;
      await judge("2019-05-12.mp4", new Uint8Array(), { type: "video" }, { fileHead: async () => { reads++; return new Uint8Array(); } });
      expect(reads).toBe(0);
    });
  });

  it("tells a saved copy's name from a camera's", () => {
    const big = { width: 4000, height: 3000 }, small = { width: 1080, height: 720 };
    expect(SavedCopyName.matches("2022-12-02 (3).jpg", big)).toBe(true);
    expect(SavedCopyName.matches("2022-12-02(3).jpg", big)).toBe(true);
    expect(SavedCopyName.matches("2022-12-02.jpg", small)).toBe(true);

    // Paragraph: a full-size photo named by date, and names with more in them, keep trusting the name.
    expect(SavedCopyName.matches("2022-12-02.jpg", big)).toBe(false);
    expect(SavedCopyName.matches("2022-12-02.jpg", { width: 0, height: 0 })).toBe(false);
    expect(SavedCopyName.matches("IMG-20190512-WA0001.jpg", small)).toBe(false);
    expect(SavedCopyName.matches("2022-12-02 holiday.jpg", small)).toBe(false);
  });

  it("never suggests a date from a format marked as saved, and it still counts as known", async () => {
    const saved = new FilenameFormats([{ mask: "IMG-yyyymmdd*.*", utc: false, saved: true }]);
    const one = item(1);
    const found: DateFixFinding[] = [];
    const source = { readItemInfo: async () => [info(one, "IMG-20190512.jpg")] };
    const stats = await new FilenameDateDetector(source, saved, memory(), noHeads).analyze([one], ctx, (f) => found.push(f));
    expect(found).toEqual([]);
    expect(stats.unmatchedNames).toBe(0);
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
    const stats = await new FilenameDateDetector(failing(ErrorCode.RpcEnvelopeMissing), formats, memory(), noHeads).analyze(items, ctx, () => {});
    expect(stats.failures).toHaveLength(2);
    await expect(new FilenameDateDetector(failing(ErrorCode.AccountMismatch), formats, memory(), noHeads).analyze(items, ctx, () => {})).rejects.toMatchObject({ code: ErrorCode.AccountMismatch });
  });
});

describe("DateFixApplier", () => {
  const plan = (n: number): PlannedDate => ({ mediaKey: `key${n}`, fileName: `file${n}.jpg`, dedupKey: `dedup${n}`, takenAtMs: 1_000_000_000_000 + n * 1000, timezoneOffsetMs: 7_200_000 });

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

  it("names the file that did not stick", async () => {
    const writer = { setDates: async () => {}, readItemInfo: async (keys: string[]) => keys.map((mediaKey) => ({ mediaKey, fileName: null, takenAtMs: 5_000, timezoneOffsetMs: 0 })) };
    const run = new DateFixApplier(writer).run([{ mediaKey: "AF1QipITEM", fileName: "2022-12-02 (3).jpg", dedupKey: "d", takenAtMs: 9_000, timezoneOffsetMs: 0 }], () => false, () => {});
    await expect(run).rejects.toMatchObject({ code: ErrorCode.DateNotApplied, message: "1 of 1 items did not get the new date: 2022-12-02 (3).jpg. Stopped.", details: { examples: [{ wantedMs: 9_000, gotMs: 5_000 }] } });
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
