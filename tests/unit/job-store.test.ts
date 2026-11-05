import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { JobStore, type SplitJob } from "../../src/extension/storage/job-store.js";
import { SplitSession } from "../../src/extension/editor/split-session.js";
import { DEFAULT_STITCH_SETTINGS } from "../../src/imaging/panorama/stitch-runtime.js";
import { AdjustmentPresets } from "../../src/imaging/enhance/adjustments.js";

function job(id: string, status: SplitJob["status"], mediaKey = "AF1QipSOURCE00000000"): SplitJob {
  const quad = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] as SplitJob["prints"][number]["quad"];
  return { id, kind: "split", accountEmail: "a@b.com", sourceMediaKey: mediaKey, sourceFileName: "scan.jpg", sourceWidth: 100, sourceHeight: 100, status, prints: [{ id: "p1", quad, rotation: 0, included: true, confidence: 1, adjustments: AdjustmentPresets.auto(), saved: null, error: null }], createdAt: 1, updatedAt: 1 };
}

describe("JobStore", () => {
  it("persists, resumes the latest unfinished job and lists recent", async () => {
    const store = await JobStore.open();
    await store.put(job("done", "done"));
    await new Promise((r) => setTimeout(r, 5));
    await store.put(job("open", "partial"));
    expect((await store.latestOpenForSource("a@b.com", "AF1QipSOURCE00000000"))?.id).toBe("open");
    expect(await store.latestOpenForSource("other@b.com", "AF1QipSOURCE00000000")).toBeNull();
    expect((await store.recent(10)).map((j) => j.id)).toEqual(["open", "done"]);
    await expect(store.get("missing")).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    // v0.1 records without adjustments are upgraded on read.
    const legacy = job("legacy", "editing", "AF1QipLEGACY0000000");
    delete (legacy.prints[0] as Partial<typeof legacy.prints[0]>).adjustments;
    await store.put(legacy);
    const upgraded = await store.get("legacy");
    expect(upgraded.kind === "split" && upgraded.prints[0]!.adjustments).toEqual(AdjustmentPresets.auto());
    // Panorama jobs share the store but never resume a split.
    const now = Date.now();
    await store.put({ id: "pano", kind: "panorama", accountEmail: "a@b.com", sourceMediaKey: "AF1QipPANO000000000", sourceMediaKeys: ["AF1QipPANO000000000", "AF1QipPANO000000001"], usedMediaKeys: [], settings: DEFAULT_STITCH_SETTINGS, status: "editing", saved: null, error: null, createdAt: now, updatedAt: now });
    expect(await store.latestOpenForSource("a@b.com", "AF1QipPANO000000000")).toBeNull();
    expect((await store.get("pano")).kind).toBe("panorama");
    store.close();
  });
});

describe("SplitSession helpers", () => {
  it("names outputs safely", () => {
    expect(SplitSession.outputName("Album page 3.HEIC", 2)).toBe("Album page 3_photo-02.jpg");
    expect(SplitSession.outputName("we/ird:name?.jpg", 11)).toBe("we_ird_name__photo-11.jpg");
    expect(SplitSession.outputName(null, 1)).toBe("scan_photo-01.jpg");
  });

  it("validates editor URL parameters", () => {
    expect(SplitSession.paramsFromUrl("?tab=5&email=a%40b.com&media=AF1QipXXXXXXXX")).toEqual({ tabId: 5, email: "a@b.com", mediaKey: "AF1QipXXXXXXXX" });
    expect(() => SplitSession.paramsFromUrl("?tab=x&email=a@b.com&media=AF1QipXXXXXXXX")).toThrow(/valid photo reference/);
  });
});
