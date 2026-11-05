import { describe, expect, it } from "vitest";
import { EditorSession } from "../../src/extension/editor/editor-session.js";
import { PanoramaSession } from "../../src/extension/editor/panorama/panorama-session.js";
import { FixDatesTool, MAX_SCAN_SELECTION, ToolEligibility, TOOLS } from "../../src/extension/tools.js";
import { ScanPlans } from "../../src/scan/scan-plan.js";
import { ErrorCode } from "../../src/shared/errors.js";

const photo = (n: number) => ({ mediaKey: `AF1QipPHOTO${String(n).padStart(9, "0")}`, type: "photo" });

describe("ToolEligibility", () => {
  it("offers Split for 1–100 photos and Panorama for 2–40", () => {
    expect(ToolEligibility.mediaKeys("split", [photo(1)])).toEqual([photo(1).mediaKey]);
    expect(ToolEligibility.mediaKeys("split", [photo(1), photo(2)])).toHaveLength(2);
    expect(ToolEligibility.mediaKeys("split", Array.from({ length: TOOLS.split.maxPhotos + 1 }, (_, i) => photo(i)))).toBeNull();
    expect(ToolEligibility.mediaKeys("panorama", [photo(1)])).toBeNull();
    expect(ToolEligibility.mediaKeys("panorama", [photo(1), photo(2)])).toHaveLength(2);
    const many = Array.from({ length: TOOLS.panorama.maxPhotos + 1 }, (_, i) => photo(i));
    expect(ToolEligibility.mediaKeys("panorama", many)).toBeNull();
  });

  it("never offers tools for selections containing videos", () => {
    expect(ToolEligibility.mediaKeys("panorama", [photo(1), { mediaKey: "AF1QipVIDEO000000000", type: "video" }])).toBeNull();
  });
});

describe("FixDatesTool", () => {
  it("takes photos and videos alike, and looks for nothing else", () => {
    const video = { mediaKey: "AF1QipVIDEO000000000", type: "video" };
    expect(FixDatesTool.plan([photo(1), video])).toEqual({ scope: { kind: "selection", mediaKeys: [photo(1).mediaKey, video.mediaKey] }, detectors: { panorama: false, dates: true }, recheck: false });
  });

  it("needs a selection a scan can hold", () => {
    expect(FixDatesTool.plan([])).toBeNull();
    expect(FixDatesTool.plan(Array.from({ length: MAX_SCAN_SELECTION + 1 }, (_, i) => photo(i)))).toBeNull();
  });
});

describe("ScanPlans dates", () => {
  it("covers both days whole, in local time", () => {
    const range = ScanPlans.dateRange("2024-03-01", "2024-03-02");
    expect(range).toMatchObject({ kind: "dateRange", fromMs: new Date(2024, 2, 1).getTime(), toMs: new Date(2024, 2, 3).getTime() - 1 });
    expect(ScanPlans.isoDate(new Date(2024, 0, 5))).toBe("2024-01-05");
    expect(() => ScanPlans.localDayStart("soon")).toThrow("Enter a valid date.");
  });
});

describe("EditorSession.parseParams", () => {
  it("parses several media keys and enforces the tool's photo count", () => {
    const p = PanoramaSession.paramsFromUrl("?tab=7&email=a%40b.com&media=AF1QipAAAAAAAAAA,AF1QipBBBBBBBBBB");
    expect(p).toEqual({ tabId: 7, email: "a@b.com", mediaKeys: ["AF1QipAAAAAAAAAA", "AF1QipBBBBBBBBBB"] });
    expect(() => PanoramaSession.paramsFromUrl("?tab=7&email=a%40b.com&media=AF1QipAAAAAAAAAA")).toThrow(expect.objectContaining({ code: ErrorCode.InvalidMessage }));
    expect(() => EditorSession.parseParams("?tab=x&email=a%40b.com&media=AF1QipAAAAAAAAAA", { min: 1, max: 1 })).toThrow();
  });
});

describe("PanoramaSession helpers", () => {
  it("names outputs safely", () => {
    expect(PanoramaSession.outputName("IMG_1234.HEIC")).toBe("IMG_1234_panorama.jpg");
    expect(PanoramaSession.outputName("we/ird:name?.jpg")).toBe("we_ird_name__panorama.jpg");
    expect(PanoramaSession.outputName(null)).toBe("photos_panorama.jpg");
  });
});
