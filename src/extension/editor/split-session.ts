/**
 * Split-into-Photos session controller (UI-framework independent).
 *
 * Owns: the source item, the decoded image (via the worker), the editable list
 * of prints and their fixes, the persistent job record, and the save
 * pipeline. The view subscribes to snapshots and calls intent methods.
 */

import type { MediaItemInfo } from "../../domain/types.js";
import { AdjustmentPresets, type Adjustments, type BrushStroke } from "../../imaging/enhance/adjustments.js";
import type { Point, Quad } from "../../imaging/geometry.js";
import { Base64 } from "../../shared/codec.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { Messenger } from "../messaging/protocol.js";
import { JobStore, type SplitJob, type SplitPrintRecord } from "../storage/job-store.js";
import { TOOLS } from "../tools.js";
import { EditorSession } from "./editor-session.js";
import type { FixController, FixView } from "./fix/fix-controller.js";
import { SplitWorkerClient } from "./worker-client.js";

export interface SplitParams {
  tabId: number;
  email: string;
  mediaKey: string;
}

export type Phase =
  | { name: "loading"; step: string }
  | { name: "ready" }
  | { name: "saving"; done: number; total: number }
  | { name: "finished" }
  | { name: "failed"; error: SerializedError };

export interface Snapshot {
  params: SplitParams;
  phase: Phase;
  item: MediaItemInfo | null;
  imageUrl: string | null;
  imageSize: { width: number; height: number } | null;
  lightingAvailable: boolean;
  job: SplitJob | null;
  /** Fixed thumbnails per print id. */
  previews: Record<string, string>;
  selectedId: string | null;
  /** Set when an unfinished earlier job was resumed: how many photos it had already saved. */
  resumed: { savedBefore: number } | null;
  fix: FixView | null;
}

/** Hosts the Fix feature for each print (see fix/fix-controller.ts). */
export class SplitSession extends EditorSession<Snapshot> implements FixController {
  #worker = new SplitWorkerClient();
  #store: JobStore | null = null;
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #fixGeneration = 0;

  constructor(params: SplitParams) {
    super({
      params,
      phase: { name: "loading", step: "Connecting to Google Photos…" },
      item: null,
      imageUrl: null,
      imageSize: null,
      lightingAvailable: false,
      job: null,
      previews: {},
      selectedId: null,
      resumed: null,
      fix: null,
    });
  }

  static paramsFromUrl(search: string): SplitParams {
    const p = EditorSession.parseParams(search, { min: TOOLS.split.minPhotos, max: TOOLS.split.maxPhotos });
    return { tabId: p.tabId, email: p.email, mediaKey: p.mediaKeys[0]! };
  }

  dispose(): void {
    this.#worker.dispose();
    this.#store?.close();
    for (const url of Object.values(this.snapshot.previews)) URL.revokeObjectURL(url);
    if (this.snapshot.imageUrl) URL.revokeObjectURL(this.snapshot.imageUrl);
    this.revokeFix(this.snapshot.fix);
  }

  // ---- loading -------------------------------------------------------------

  async init(): Promise<void> {
    try {
      const { params } = this.snapshot;

      // Paragraph: item info through the bound Photos tab.
      this.#store = await JobStore.open();
      const tabId = await this.boundTab();
      const item = await Messenger.toPhotosTab(tabId, { type: "photos.getItem", expectedEmail: params.email, mediaKey: params.mediaKey });
      if (item.type === "video") throw new PixError(ErrorCode.InvalidImage, "Split into Photos works on photos, not videos.");
      this.set({ item, phase: { name: "loading", step: "Downloading the original…" } });

      // Paragraph: original bytes -> worker (decode, scene lighting).
      const original = await Messenger.toPhotosTab(tabId, { type: "photos.downloadOriginal", expectedEmail: params.email, mediaKey: params.mediaKey });
      const blob = new Blob([Base64.decode(original.bytesBase64) as Uint8Array<ArrayBuffer>], { type: original.mimeType });
      this.set({ phase: { name: "loading", step: "Finding photos in the scan…" } });
      const loaded = await this.#worker.load(await createImageBitmap(blob));
      const size = { width: loaded.width, height: loaded.height };
      this.set({ imageUrl: URL.createObjectURL(blob), imageSize: size, lightingAvailable: loaded.lightingAvailable });

      // Paragraph: resume an unfinished job or detect afresh.
      const existing = await this.#store.latestOpenForSource(params.email, params.mediaKey);
      const job = existing && existing.sourceWidth === size.width && existing.sourceHeight === size.height ? existing : await this.newJob(item, size);
      this.set({ job, resumed: job === existing ? { savedBefore: job.prints.filter((p) => p.saved).length } : null, phase: { name: "ready" }, selectedId: job.prints[0]?.id ?? null });
      for (const p of job.prints) this.scheduleThumb(p.id, 0);
    } catch (err) {
      this.fail(err);
    }
  }

  private async newJob(item: MediaItemInfo, size: { width: number; height: number }): Promise<SplitJob> {
    const detected = await this.#worker.detect();
    const now = Date.now();
    return this.requireStore().put({
      id: crypto.randomUUID(),
      kind: "split",
      accountEmail: this.snapshot.params.email,
      sourceMediaKey: item.ref.mediaKey,
      sourceFileName: item.fileName,
      sourceWidth: size.width,
      sourceHeight: size.height,
      status: "editing",
      prints: detected.map((d) => SplitSession.printRecord(d.quad, d.confidence)),
      createdAt: now,
      updatedAt: now,
    });
  }

  // ---- outline editing ---------------------------------------------------------

  select(id: string | null): void {
    this.set({ selectedId: id });
  }

  updateQuad(id: string, quad: Quad): void {
    this.mutatePrint(id, (p) => ({ ...p, quad, confidence: null }));
    this.scheduleThumb(id, 200);
  }

  rotate(id: string, delta: 1 | -1): void {
    this.mutatePrint(id, (p) => ({ ...p, rotation: (p.rotation + delta + 4) % 4 }));
    this.scheduleThumb(id, 0);
    const fix = this.snapshot.fix;
    if (fix?.targetId === id) {
      if (fix.originalUrl) URL.revokeObjectURL(fix.originalUrl); // the "before" image must rotate too
      this.set({ fix: { ...fix, originalUrl: null } });
      this.scheduleFix(0);
    }
  }

  /** Rotates every unsaved photo (prints photographed sideways are usually all turned the same way). */
  rotateAll(delta: 1 | -1): void {
    const job = this.requireJob();
    this.commitJob({ ...job, prints: job.prints.map((p) => (p.saved ? p : { ...p, rotation: (p.rotation + delta + 4) % 4 })) });
    for (const p of job.prints) if (!p.saved) this.scheduleThumb(p.id, 0);
  }

  toggleIncluded(id: string): void {
    this.mutatePrint(id, (p) => ({ ...p, included: !p.included }));
  }

  remove(id: string): void {
    const job = this.requireJob();
    if (job.prints.find((p) => p.id === id)?.saved) return; // saved prints stay on record
    this.commitJob({ ...job, prints: job.prints.filter((p) => p.id !== id) });
    const previews = { ...this.snapshot.previews };
    if (previews[id]) URL.revokeObjectURL(previews[id]);
    delete previews[id];
    this.set({ previews, selectedId: null });
  }

  /** Adds a centred rectangle covering ~40% of the image for the user to adjust. */
  addPrint(): void {
    const size = this.snapshot.imageSize;
    if (!size) return;
    const w = size.width * 0.4, h = size.height * 0.4, x = (size.width - w) / 2, y = (size.height - h) / 2;
    const quad: Quad = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    const rec = SplitSession.printRecord(quad, null);
    this.commitJob({ ...this.requireJob(), prints: [...this.requireJob().prints, rec] });
    this.set({ selectedId: rec.id });
    this.scheduleThumb(rec.id, 0);
  }

  // ---- fixes -------------------------------------------------------------------------

  setAdjustments(id: string, adjustments: Adjustments): void {
    this.mutatePrint(id, (p) => ({ ...p, adjustments }));
    this.scheduleThumb(id, 250);
    if (this.snapshot.fix?.targetId === id) this.scheduleFix(120);
  }

  addStroke(id: string, stroke: BrushStroke): void {
    const print = this.requirePrint(id);
    this.setAdjustments(id, { ...print.adjustments, strokes: [...print.adjustments.strokes, stroke] });
  }

  undoStroke(id: string): void {
    const print = this.requirePrint(id);
    this.setAdjustments(id, { ...print.adjustments, strokes: print.adjustments.strokes.slice(0, -1) });
  }

  /** Copies slider/toggle settings (not brush strokes, which are photo-specific) to every unsaved photo. */
  applySettingsToAll(fromId: string): void {
    const src = this.requirePrint(fromId).adjustments;
    const job = this.requireJob();
    this.commitJob({ ...job, prints: job.prints.map((p) => (p.saved || p.id === fromId ? p : { ...p, adjustments: { ...src, strokes: p.adjustments.strokes } })) });
    for (const p of job.prints) if (!p.saved && p.id !== fromId) this.scheduleThumb(p.id, 0);
  }

  openFix(id: string): void {
    this.revokeFix(this.snapshot.fix);
    this.set({ selectedId: id, fix: { targetId: id, fixedUrl: null, originalUrl: null, maskUrl: null, report: null, busy: true } });
    this.scheduleFix(0);
  }

  closeFix(): void {
    this.revokeFix(this.snapshot.fix);
    this.set({ fix: null });
  }

  // ---- saving ------------------------------------------------------------------

  /** Uploads every included, not-yet-saved print as a new item. Idempotent across retries. */
  async save(matchSourceDate: boolean): Promise<void> {
    const item = this.snapshot.item;
    if (!item) return;
    let job = this.commitJob({ ...this.requireJob(), status: "saving" });
    const todo = job.prints.filter((p) => p.included && !p.saved);
    let done = 0;
    this.set({ phase: { name: "saving", done, total: todo.length } });

    for (const print of todo) {
      // Paragraph: render full resolution with fixes and upload through the bound tab.
      const index = job.prints.findIndex((p) => p.id === print.id) + 1;
      const fileName = SplitSession.outputName(item.fileName, index);
      try {
        const { image } = await this.#worker.render({ quad: print.quad, rotation: print.rotation, adjustments: print.adjustments, size: "full", wantMask: false });
        const bytesBase64 = Base64.encode(new Uint8Array(await image.arrayBuffer()));
        const tabId = await this.boundTab();
        const created = await Messenger.toPhotosTab(tabId, {
          type: "photos.uploadPhoto",
          expectedEmail: this.snapshot.params.email,
          fileName,
          bytesBase64,
          ...(matchSourceDate ? { takenAtMs: item.takenAtMs, timezoneOffsetMs: item.timezoneOffsetMs } : {}),
        });
        job = this.mutatePrint(print.id, (p) => ({ ...p, saved: { mediaKey: created.ref.mediaKey, webUrl: created.webUrl, fileName }, error: null }));
      } catch (err) {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Saving failed");
        job = this.mutatePrint(print.id, (p) => ({ ...p, error: e.toJSON() }));
        // Account or session problems affect every remaining print: stop instead of hammering.
        if (e.code === ErrorCode.AccountMismatch || e.code === ErrorCode.TabNotBound || e.code === ErrorCode.SessionUnavailable) break;
      }
      this.set({ phase: { name: "saving", done: ++done, total: todo.length } });
    }

    // Paragraph: final status.
    const included = job.prints.filter((p) => p.included);
    const saved = included.filter((p) => p.saved).length;
    const status = saved === included.length ? "done" : saved > 0 ? "partial" : "failed";
    this.commitJob({ ...job, status });
    this.set({ phase: status === "done" ? { name: "finished" } : { name: "ready" } });
  }

  /** Renders included prints (with fixes) and triggers local downloads (no library change). */
  async downloadAll(): Promise<void> {
    const job = this.requireJob();
    for (const [i, p] of job.prints.entries()) {
      if (!p.included) continue;
      const { image } = await this.#worker.render({ quad: p.quad, rotation: p.rotation, adjustments: p.adjustments, size: "full", wantMask: false });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(image);
      a.download = SplitSession.outputName(this.snapshot.item?.fileName ?? null, i + 1);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
  }

  // ---- rendering ------------------------------------------------------------------

  private scheduleThumb(id: string, delayMs: number): void {
    this.debounce(`thumb:${id}`, delayMs, () => this.renderThumb(id));
  }

  private scheduleFix(delayMs: number): void {
    this.debounce("fix", delayMs, () => this.renderFix());
  }

  private debounce(key: string, delayMs: number, fn: () => Promise<void>): void {
    const prev = this.#timers.get(key);
    if (prev) clearTimeout(prev);
    this.#timers.set(key, setTimeout(() => void fn(), delayMs));
  }

  private async renderThumb(id: string): Promise<void> {
    const print = this.snapshot.job?.prints.find((p) => p.id === id);
    if (!print) return;
    try {
      const { image } = await this.#worker.render({ quad: print.quad, rotation: print.rotation, adjustments: print.adjustments, size: "thumb", wantMask: false });
      const previews = { ...this.snapshot.previews };
      if (previews[id]) URL.revokeObjectURL(previews[id]);
      previews[id] = URL.createObjectURL(image);
      this.set({ previews });
    } catch (err) {
      this.mutatePrint(id, (p) => ({ ...p, error: PixError.wrap(err, ErrorCode.InvalidGeometry, "Preview failed").toJSON() }));
    }
  }

  /** Renders the large fixed + original + treated-mask previews for the open Fix view. */
  private async renderFix(): Promise<void> {
    const fix = this.snapshot.fix;
    if (!fix) return;
    const print = this.requirePrint(fix.targetId);
    const generation = ++this.#fixGeneration;
    this.set({ fix: { ...fix, busy: true } });
    try {
      const base = { quad: print.quad, rotation: print.rotation, size: "preview" as const };
      const [fixed, original] = await Promise.all([
        this.#worker.render({ ...base, adjustments: print.adjustments, wantMask: true }),
        fix.originalUrl ? Promise.resolve(null) : this.#worker.render({ ...base, adjustments: AdjustmentPresets.none(), wantMask: false }),
      ]);
      if (generation !== this.#fixGeneration || this.snapshot.fix?.targetId !== fix.targetId) return; // superseded
      const current = this.snapshot.fix!;
      if (current.fixedUrl) URL.revokeObjectURL(current.fixedUrl);
      if (current.maskUrl) URL.revokeObjectURL(current.maskUrl);
      this.set({
        fix: {
          ...current,
          busy: false,
          fixedUrl: URL.createObjectURL(fixed.image),
          maskUrl: fixed.mask ? URL.createObjectURL(fixed.mask) : null,
          originalUrl: original ? URL.createObjectURL(original.image) : current.originalUrl,
          report: fixed.report,
        },
      });
    } catch (err) {
      this.fail(err);
    }
  }

  private revokeFix(fix: FixView | null): void {
    if (!fix) return;
    for (const u of [fix.fixedUrl, fix.originalUrl, fix.maskUrl]) if (u) URL.revokeObjectURL(u);
  }

  // ---- internals -----------------------------------------------------------------

  private boundTab(): Promise<number> {
    return this.photosTab(this.snapshot.params.email, this.snapshot.params.tabId);
  }

  private mutatePrint(id: string, fn: (p: SplitPrintRecord) => SplitPrintRecord): SplitJob {
    const job = this.requireJob();
    return this.commitJob({ ...job, prints: job.prints.map((p) => (p.id === id ? fn(p) : p)) });
  }

  /** Updates the snapshot immediately and persists asynchronously (errors surface as a failed phase). */
  private commitJob(job: SplitJob): SplitJob {
    const next = { ...job, updatedAt: Date.now() };
    this.set({ job: next });
    this.requireStore().put(next).catch((err: unknown) => this.fail(err));
    return next;
  }

  private requireJob(): SplitJob {
    if (!this.snapshot.job) throw new PixError(ErrorCode.JobNotFound, "No split job is active");
    return this.snapshot.job;
  }

  private requirePrint(id: string): SplitPrintRecord {
    const p = this.requireJob().prints.find((x) => x.id === id);
    if (!p) throw new PixError(ErrorCode.JobNotFound, "Photo not found in this split", { id });
    return p;
  }

  private requireStore(): JobStore {
    if (!this.#store) throw new PixError(ErrorCode.StorageFailed, "Storage not open");
    return this.#store;
  }

  static printRecord(quad: Quad, confidence: number | null): SplitPrintRecord {
    return {
      id: crypto.randomUUID(),
      quad: quad.map((p: Point) => ({ x: p.x, y: p.y })) as Quad,
      rotation: 0,
      included: true,
      confidence,
      adjustments: AdjustmentPresets.auto(),
      saved: null,
      error: null,
    };
  }

  static outputName(sourceName: string | null, index: number): string {
    const base = (sourceName ?? "scan").replace(/\.[^.]+$/, "").replace(/[^\w\- .]+/g, "_").slice(0, 80) || "scan";
    return `${base}_photo-${String(index).padStart(2, "0")}.jpg`;
  }
}
