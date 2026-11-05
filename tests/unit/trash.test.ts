import { describe, expect, it } from "vitest";
import { PanoramaOriginals } from "../../src/extension/editor/panorama/panorama-originals.js";
import { ScanSession } from "../../src/extension/scan/scan-session.js";
import { ScanTabs } from "../../src/extension/scan/scan-tabs.js";
import type { PanoramaJob } from "../../src/extension/storage/job-store.js";
import type { Page } from "../../src/domain/types.js";
import type { PanoramaCandidate } from "../../src/scan/panorama-detector.js";
import { TrashMover } from "../../src/scan/trash-mover.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";

/** A trash that really tracks what was moved, in pages, and can ignore items or list them late. */
class FakeTrash {
  readonly moved = new Set<string>();
  readonly batches: string[][] = [];
  readonly refused = new Set<string>();
  readonly log: string[] = [];
  lateListings = 0;
  pageSize = 2;

  async moveToTrash(keys: string[]): Promise<void> {
    this.log.push("move");
    this.batches.push(keys);
    for (const k of keys) if (!this.refused.has(k)) this.moved.add(k);
  }

  async listTrash(page: string | null): Promise<Page<string>> {
    if (this.lateListings > 0) {
      this.lateListings--;
      return { items: [], next: null };
    }
    const all = [...this.moved];
    const start = page === null ? 0 : Number(page);
    const end = start + this.pageSize;
    return { items: all.slice(start, end), next: end < all.length ? String(end) : null };
  }

  async getItem(_key: string): Promise<never> {
    this.log.push("getItem");
    return {} as never;
  }
}

const noWait = async () => {};
const job = (patch: Partial<PanoramaJob> = {}): PanoramaJob => ({
  id: "job", kind: "panorama", accountEmail: "a@b.com", sourceMediaKey: "AF1QipSOURCE", sourceMediaKeys: ["AF1QipSOURCE"], usedMediaKeys: ["m1"], usedDedupKeys: ["d1", "d2", "d3"],
  settings: {} as PanoramaJob["settings"], status: "done", saved: { mediaKey: "AF1QipPANO", webUrl: "https://x", fileName: "p.jpg", width: 1, height: 1 }, error: null, createdAt: 0, updatedAt: 0, ...patch,
});
const recordingStore = (log: string[] = []) => ({
  saved: [] as PanoramaJob[],
  async put<J>(j: J): Promise<J> {
    log.push("record");
    this.saved.push(j as unknown as PanoramaJob);
    return j;
  },
});

describe("TrashMover", () => {
  it("moves in batches and finds each item across trash pages", async () => {
    const trash = new FakeTrash();
    const keys = Array.from({ length: TrashMover.BATCH + 3 }, (_, i) => `key${i}`);
    const confirmed: string[] = [];
    await new TrashMover(trash, noWait).run(keys, (k) => void confirmed.push(...k));
    expect(trash.batches.map((b) => b.length)).toEqual([TrashMover.BATCH, 3]);
    expect(confirmed).toEqual(keys);
  });

  it("waits for a trash that lists new items late", async () => {
    const trash = new FakeTrash();
    trash.lateListings = TrashMover.CHECKS - 1;
    await expect(new TrashMover(trash, noWait).run(["a"], () => {})).resolves.toBeUndefined();
  });

  it("fails when the call succeeds but the item never reaches the trash, keeping what did", async () => {
    const trash = new FakeTrash();
    trash.refused.add("b");
    const confirmed: string[] = [];
    const run = new TrashMover(trash, noWait).run(["a", "b", "c"], (k) => void confirmed.push(...k));
    await expect(run).rejects.toMatchObject({ code: ErrorCode.TrashNotApplied, message: "1 of 3 photos did not reach the trash. Stopped." });
    expect(confirmed).toEqual(["a", "c"]);
  });

  it("does not start another batch after a failure", async () => {
    const trash = new FakeTrash();
    trash.refused.add("key0");
    const keys = Array.from({ length: TrashMover.BATCH + 1 }, (_, i) => `key${i}`);
    await expect(new TrashMover(trash, noWait).run(keys, () => {})).rejects.toBeInstanceOf(PixError);
    expect(trash.batches).toHaveLength(1);
  });
});

describe("PanoramaOriginals", () => {
  it("confirms the panorama, records, then moves, and ends as moved", async () => {
    const trash = new FakeTrash();
    const store = recordingStore(trash.log);
    const r = await new PanoramaOriginals(trash, store, new TrashMover(trash, noWait)).trash(job(), ["d1", "d2", "d3"]);
    expect(r.error).toBeNull();
    expect(trash.log.slice(0, 3)).toEqual(["getItem", "record", "move"]);
    expect(r.job.originalsTrash).toEqual({ dedupKeys: ["d1", "d2", "d3"], moved: ["d1", "d2", "d3"], state: "moved" });
    expect([...trash.moved]).toEqual(["d1", "d2", "d3"]);
  });

  it("moves nothing when the panorama cannot be found", async () => {
    const trash = new FakeTrash();
    trash.getItem = async () => { throw new PixError(ErrorCode.RpcUnexpectedShape, "gone"); };
    const store = recordingStore();
    const r = await new PanoramaOriginals(trash, store, new TrashMover(trash, noWait)).trash(job(), ["d1"]);
    expect(r.error?.code).toBe(ErrorCode.OriginalsKept);
    expect(trash.batches).toHaveLength(0);
    expect(store.saved).toHaveLength(0);
  });

  it("moves nothing for a panorama that was never saved", async () => {
    const trash = new FakeTrash();
    const r = await new PanoramaOriginals(trash, recordingStore(), new TrashMover(trash, noWait)).trash(job({ saved: null }), ["d1"]);
    expect(r.error?.code).toBe(ErrorCode.OriginalsKept);
    expect(trash.batches).toHaveLength(0);
  });

  it("does not hide an account problem behind 'not found'", async () => {
    const trash = new FakeTrash();
    trash.getItem = async () => { throw new PixError(ErrorCode.AccountMismatch, "other account"); };
    const r = await new PanoramaOriginals(trash, recordingStore(), new TrashMover(trash, noWait)).trash(job(), ["d1"]);
    expect(r.error?.code).toBe(ErrorCode.AccountMismatch);
  });

  it("records a partial run as failed, and a retry only moves the rest", async () => {
    const trash = new FakeTrash();
    trash.refused.add("d2");
    const originals = new PanoramaOriginals(trash, recordingStore(), new TrashMover(trash, noWait));
    const first = await originals.trash(job(), ["d1", "d2", "d3"]);
    expect(first.error?.code).toBe(ErrorCode.TrashNotApplied);
    expect(first.job.originalsTrash).toEqual({ dedupKeys: ["d1", "d2", "d3"], moved: ["d1", "d3"], state: "failed" });

    trash.refused.clear();
    const second = await originals.trash(first.job, ["d2"]);
    expect(second.error).toBeNull();
    expect(trash.batches.at(-1)).toEqual(["d2"]);
    expect(second.job.originalsTrash).toEqual({ dedupKeys: ["d1", "d2", "d3"], moved: ["d1", "d3", "d2"], state: "moved" });
  });
});

describe("what may go to trash from a scan", () => {
  const item = (dedupKey: string, editable?: boolean) => ({ dedupKey, ...(editable === undefined ? {} : { editable }) });
  const view = (items: ReturnType<typeof item>[], j: PanoramaJob | null) => ({ candidate: { items } as unknown as PanoramaCandidate, result: j && { job: j, webUrl: "", width: 1, height: 1, albums: [], problems: [], skipped: 0, warnings: [] } });

  it("only photos in the panorama, never one left out of it", () => {
    expect(ScanSession.trashableKeys(view([item("d1"), item("d2"), item("d3")], job({ usedDedupKeys: ["d1", "d3"] })))).toEqual(["d1", "d3"]);
  });

  it("never someone else's photo", () => {
    expect(ScanSession.trashableKeys(view([item("d1"), item("d2", false)], job({ usedDedupKeys: ["d1", "d2"] })))).toEqual(["d1"]);
  });

  it("not what is already in the trash", () => {
    expect(ScanSession.trashableKeys(view([item("d1"), item("d2")], job({ usedDedupKeys: ["d1", "d2"], originalsTrash: { dedupKeys: ["d1", "d2"], moved: ["d1"], state: "failed" } })))).toEqual(["d2"]);
  });

  it("nothing before a panorama is created", () => {
    expect(ScanSession.trashableKeys(view([item("d1")], null))).toEqual([]);
  });
});

describe("ScanTabs", () => {
  const both = { panorama: true, dates: true, duplicates: false };
  it("has one tab per thing looked for, counted, even when it found nothing", () => {
    expect(ScanTabs.list(both, { panorama: 0, dates: 47, duplicates: 0 })).toEqual([{ id: "panorama", label: "Panoramas", count: 0 }, { id: "dates", label: "Wrong dates", count: 47 }]);
    expect(ScanTabs.list({ panorama: false, dates: true, duplicates: false }, { panorama: 0, dates: 1, duplicates: 0 }).map((t) => t.id)).toEqual(["dates"]);
  });

  it("shows the chosen tab, or the first this scan has", () => {
    expect(ScanTabs.active(both, "dates")).toBe("dates");
    expect(ScanTabs.active(both, null)).toBe("panorama");
    expect(ScanTabs.active({ panorama: false, dates: true, duplicates: false }, null)).toBe("dates");
    expect(ScanTabs.active({ panorama: false, dates: true, duplicates: false }, "panorama")).toBe("dates");
  });
});
