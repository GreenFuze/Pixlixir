import { describe, expect, it } from "vitest";
import type { LibraryItem } from "../../src/domain/types.js";
import { DateFixRow, type DateFixView } from "../../src/extension/scan/scan-session.js";
import { ScanEta } from "../../src/scan/scan-eta.js";

const DAY = 86_400_000;
const item = (over: Partial<LibraryItem> = {}): LibraryItem => ({ mediaKey: "AF1QipITEM", dedupKey: "dedup", type: "photo", width: 720, height: 431, takenAtMs: 1000 * DAY, timezoneOffsetMs: 0, baseUrl: "https://x/1", location: null, ...over });
const format = (ms: number) => `day ${Math.floor(ms / DAY)}`;
const row = (over: Partial<DateFixView> = {}, finding: Partial<DateFixView["finding"]> = {}): Pick<DateFixView, "finding" | "copy" | "original" | "searched"> => ({
  copy: true, original: null, searched: true, ...over,
  finding: { id: "dates:1", detector: "dates", mediaKeys: ["AF1QipITEM"], item: item(), fileName: "2022-12-02 (3).jpg", mask: "yyyy-mm-dd*.*", newTakenAtMs: 2000 * DAY, exportDate: true, copyReason: "file", fileAgrees: false, fileTakenLocalMs: 1000 * DAY, ...finding },
});
const original = (takenAtMs: number) => ({ item: item({ dedupKey: "other", width: 4000, height: 3000, takenAtMs }), similarity: 100, thumbUrl: null });

describe("DateFixRow", () => {
  it("says when Google already shows the file's own date, without claiming it is right", () => {
    const help = DateFixRow.help(row(), format);
    expect(help).toContain("the file's own date is day 1000");
    expect(help).toContain("Google Photos already shows the file's own date, day 1000. That may be right");
    expect(help).toContain("No larger photo of this picture was found, so nothing is changed.");
  });

  it("explains a wrong date and what Fix will write", () => {
    const help = DateFixRow.help(row({ copy: false }, { copyReason: null, exportDate: false, fileAgrees: true, fileTakenLocalMs: 2000 * DAY }), format);
    expect(help).toContain("but the name 2022-12-02 (3).jpg says day 2000");
    expect(help).toContain("agrees with the name");
    expect(help).toContain("Fix writes the name's date.");
  });

  it("says what an original gives, and that one with the same date gives nothing", () => {
    expect(DateFixRow.help(row({ original: original(500 * DAY) }), format)).toContain("likely original was taken day 500, 100% alike. Fix writes that date");
    expect(DateFixRow.help(row({ original: original(1000 * DAY + 300) }), format)).toContain("same date, so there is nothing to fix");
    expect(DateFixRow.canTakeOriginal(row({ original: original(500 * DAY) }))).toBe(true);
    expect(DateFixRow.canTakeOriginal(row({ original: original(1000 * DAY + 300) }))).toBe(false);
    expect(DateFixRow.canTakeOriginal(row())).toBe(false);
  });
});

describe("ScanEta.elapsed", () => {
  it("is short at every length", () => {
    expect(ScanEta.elapsed(0.2)).toBe("1 s");
    expect(ScanEta.elapsed(42)).toBe("42 s");
    expect(ScanEta.elapsed(600)).toBe("10 min");
    expect(ScanEta.elapsed(3 * 3600 + 12 * 60)).toBe("3 h 12 min");
  });
});
