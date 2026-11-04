import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { JobStore, type SplitJob } from "../../src/extension/storage/job-store.js";
import { SplitSession } from "../../src/extension/editor/split-session.js";

function job(id: string, status: SplitJob["status"], mediaKey = "AF1QipSOURCE00000000"): SplitJob {
  const quad = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] as SplitJob["prints"][number]["quad"];
  return { id, kind: "split", accountEmail: "a@b.com", sourceMediaKey: mediaKey, sourceFileName: "scan.jpg", sourceWidth: 100, sourceHeight: 100, status, prints: [{ id: "p1", quad, rotation: 0, included: true, confidence: 1, saved: null, error: null }], createdAt: 1, updatedAt: 1 };
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
