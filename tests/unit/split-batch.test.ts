import { describe, expect, it } from "vitest";
import { SplitBatch, type BatchScan } from "../../src/extension/editor/split-batch.js";
import type { SplitJob, SplitPrintRecord } from "../../src/extension/storage/job-store.js";
import { ErrorCode } from "../../src/shared/errors.js";
import { ScanEta } from "../../src/scan/scan-eta.js";

const print = (over: Partial<SplitPrintRecord> = {}) => ({ included: true, saved: null, error: null, ...over }) as SplitPrintRecord;

/** Fake scan session: analysis finds `found` photos; save marks them saved (unless told to fail). */
class FakeScan implements BatchScan {
  static created: FakeScan[] = [];
  static failing = new Map<string, string>();
  static saveFailure: Map<string, string> = new Map();
  snapshot: BatchScan["snapshot"] = { phase: { name: "loading" }, job: null, item: null };
  disposed = false;
  saves = 0;
  readonly #fns = new Set<(s: BatchScan["snapshot"]) => void>();

  constructor(readonly mediaKey: string, readonly found: number) {
    FakeScan.created.push(this);
  }

  subscribe(fn: (s: BatchScan["snapshot"]) => void) {
    this.#fns.add(fn);
    return () => this.#fns.delete(fn);
  }

  private publish(patch: Partial<BatchScan["snapshot"]>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const f of this.#fns) f(this.snapshot);
  }

  async init() {
    const code = FakeScan.failing.get(this.mediaKey);
    if (code) {
      this.publish({ phase: { name: "failed", error: { code: code as ErrorCode, message: "boom" } } });
      return;
    }
    this.publish({ phase: { name: "ready" }, item: { fileName: `${this.mediaKey}.jpg` }, job: { prints: Array.from({ length: this.found }, () => print()) } as SplitJob });
  }

  async save() {
    this.saves++;
    const prints = this.snapshot.job!.prints;
    const code = FakeScan.saveFailure.get(this.mediaKey);
    const next = code
      ? prints.map((p) => ({ ...p, error: { code: code as ErrorCode, message: "upload failed" } }))
      : prints.map((p) => ({ ...p, saved: { mediaKey: "m", webUrl: "u", fileName: "f" } }));
    this.publish({ phase: { name: code ? "ready" : "finished" }, job: { prints: next } as SplitJob });
  }

  async thumbnail() {
    return new Blob(["x"]);
  }

  dispose() {
    this.disposed = true;
  }
}

const KEYS = ["AF1QipSCAN0000001", "AF1QipSCAN0000002", "AF1QipSCAN0000003"];

function batch(found: Record<string, number> = {}) {
  FakeScan.created = [];
  FakeScan.failing = new Map();
  FakeScan.saveFailure = new Map();
  return new SplitBatch<FakeScan>({ tabId: 1, email: "a@b.com", mediaKeys: KEYS }, (k) => new FakeScan(k, found[k] ?? 2));
}

describe("SplitBatch", () => {
  it("accepts 1 to 100 scans in the URL", () => {
    expect(SplitBatch.paramsFromUrl(`?tab=5&email=a%40b.com&media=${KEYS.join(",")}`).mediaKeys).toEqual(KEYS);
    const many = Array.from({ length: 101 }, (_, i) => `AF1QipSCAN${String(i).padStart(7, "0")}`).join(",");
    expect(() => SplitBatch.paramsFromUrl(`?tab=5&email=a%40b.com&media=${many}`)).toThrow(/valid photo reference/);
  });

  it("analyses every scan, keeps only the reviewed one open, and counts photos", async () => {
    const b = batch({ [KEYS[1]!]: 3, [KEYS[2]!]: 0 });
    await b.init();
    expect(b.analysed).toBe(true);
    expect(b.snapshot.entries.map((e) => [e.status, e.found, e.pending])).toEqual([["ready", 2, 2], ["ready", 3, 3], ["ready", 0, 0]]);
    expect(b.snapshot.current?.mediaKey).toBe(KEYS[0]);
    expect(FakeScan.created.filter((s) => !s.disposed).map((s) => s.mediaKey)).toEqual([KEYS[0]]);
    expect(b.totals()).toEqual({ photos: 5, scans: 2, saved: 0 });
    expect(b.snapshot.entries[0]!.thumbUrl).not.toBeNull();
  });

  it("switches the reviewed scan, disposing the previous session", async () => {
    const b = batch();
    await b.init();
    const first = b.snapshot.current!;
    b.open(2);
    expect(first.disposed).toBe(true);
    expect(b.snapshot.openIndex).toBe(2);
    expect(b.snapshot.current?.mediaKey).toBe(KEYS[2]);
  });

  it("saves all scans with photos, reusing the open session and skipping empty scans", async () => {
    const b = batch({ [KEYS[2]!]: 0 });
    await b.init();
    const open = b.snapshot.current!;
    await b.saveAll(true);
    expect(open.saves).toBe(1);
    expect(b.snapshot.entries.map((e) => e.status)).toEqual(["saved", "saved", "ready"]);
    expect(b.totals()).toEqual({ photos: 0, scans: 0, saved: 4 });
    expect(b.snapshot.phase).toEqual({ name: "working" });
    expect(FakeScan.created.filter((s) => s.mediaKey === KEYS[2] && s.saves > 0)).toEqual([]);
  });

  it("reports a failed scan and still handles the others", async () => {
    const b = batch();
    FakeScan.failing.set(KEYS[1]!, ErrorCode.MediaDecodeFailed);
    await b.init();
    expect(b.snapshot.entries.map((e) => e.status)).toEqual(["ready", "failed", "ready"]);
    expect(b.snapshot.entries[1]!.error?.message).toBe("boom");
    await b.saveAll(false);
    expect(b.snapshot.entries.map((e) => e.status)).toEqual(["saved", "failed", "saved"]);
  });

  it("stops saving after an account problem", async () => {
    const b = batch();
    await b.init();
    FakeScan.saveFailure.set(KEYS[0]!, ErrorCode.AccountMismatch);
    await b.saveAll(true);
    expect(b.snapshot.entries.map((e) => e.status)).toEqual(["failed", "ready", "ready"]);
  });
});

describe("ScanEta", () => {
  it("estimates from the pace so far and restarts on a new stage", () => {
    const eta = new ScanEta();
    expect(eta.update(0, 10, 0)).toBeNull();
    expect(eta.update(2, 10, 20_000)).toBe(80);
    expect(eta.update(10, 10, 100_000)).toBe(0);
    expect(eta.update(0, 4, 200_000)).toBeNull();
    expect(eta.update(1, 4, 201_000)).toBe(3);
  });

  it("formats time left", () => {
    expect(ScanEta.format(20)).toBe("less than a minute left");
    expect(ScanEta.format(150)).toBe("about 3 min left");
    expect(ScanEta.format(5400)).toBe("about 1.5 h left");
  });
});
