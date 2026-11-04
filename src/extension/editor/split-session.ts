/**
 * Split-into-Photos session controller (UI-framework independent).
 *
 * Owns: the source item, the decoded image (via the worker), the editable list
 * of prints, the persistent job record, and the save pipeline. The view
 * subscribes to snapshots and calls intent methods.
 */

import type { MediaItemInfo } from "../../domain/types.js";
import type { Point, Quad } from "../../imaging/geometry.js";
import { Base64 } from "../../shared/codec.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { Messenger } from "../messaging/protocol.js";
import { JobStore, type SplitJob, type SplitPrintRecord } from "../storage/job-store.js";
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
  job: SplitJob | null;
  previews: Record<string, string>;
  selectedId: string | null;
  resumed: boolean;
}

export class SplitSession {
  #snap: Snapshot;
  #listeners = new Set<(s: Snapshot) => void>();
  #worker = new SplitWorkerClient();
  #store: JobStore | null = null;
  #previewTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(params: SplitParams) {
    this.#snap = { params, phase: { name: "loading", step: "Connecting to Google Photos…" }, item: null, imageUrl: null, imageSize: null, job: null, previews: {}, selectedId: null, resumed: false };
  }

  static paramsFromUrl(search: string): SplitParams {
    const q = new URLSearchParams(search);
    const tabId = Number(q.get("tab"));
    const email = q.get("email") ?? "";
    const mediaKey = q.get("media") ?? "";
    if (!Number.isInteger(tabId) || !email.includes("@") || mediaKey.length < 10) {
      throw new PixError(ErrorCode.InvalidMessage, "The editor was opened without a valid photo reference.", { tabId, hasEmail: email.length > 0 });
    }
    return { tabId, email, mediaKey };
  }

  // ---- subscription ------------------------------------------------------

  get snapshot(): Snapshot {
    return this.#snap;
  }

  subscribe(fn: (s: Snapshot) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  private set(patch: Partial<Snapshot>): void {
    this.#snap = { ...this.#snap, ...patch };
    for (const fn of this.#listeners) fn(this.#snap);
  }

  dispose(): void {
    this.#worker.dispose();
    this.#store?.close();
    for (const url of Object.values(this.#snap.previews)) URL.revokeObjectURL(url);
    if (this.#snap.imageUrl) URL.revokeObjectURL(this.#snap.imageUrl);
  }

  // ---- loading -------------------------------------------------------------

  async init(): Promise<void> {
    try {
      const { params } = this.#snap;

      // Paragraph: item info through the bound Photos tab.
      this.#store = await JobStore.open();
      const tabId = await this.photosTab();
      const item = await Messenger.toPhotosTab(tabId, { type: "photos.getItem", expectedEmail: params.email, mediaKey: params.mediaKey });
      if (item.type === "video") throw new PixError(ErrorCode.InvalidImage, "Split into Photos works on photos, not videos.");
      this.set({ item, phase: { name: "loading", step: "Downloading the original…" } });

      // Paragraph: original bytes -> worker.
      const original = await Messenger.toPhotosTab(tabId, { type: "photos.downloadOriginal", expectedEmail: params.email, mediaKey: params.mediaKey });
      const blob = new Blob([Base64.decode(original.bytesBase64) as Uint8Array<ArrayBuffer>], { type: original.mimeType });
      this.set({ phase: { name: "loading", step: "Finding photos in the scan…" } });
      const size = await this.#worker.load(await createImageBitmap(blob));
      this.set({ imageUrl: URL.createObjectURL(blob), imageSize: size });

      // Paragraph: resume an unfinished job or detect afresh.
      const existing = await this.#store.latestOpenForSource(params.email, params.mediaKey);
      const job = existing && existing.sourceWidth === size.width && existing.sourceHeight === size.height ? existing : await this.newJob(item, size);
      this.set({ job, resumed: job === existing, phase: { name: "ready" }, selectedId: job.prints[0]?.id ?? null });
      for (const p of job.prints) this.schedulePreview(p.id, 0);
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
      accountEmail: this.#snap.params.email,
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


  // ---- editing intents -------------------------------------------------------

  select(id: string | null): void {
    this.set({ selectedId: id });
  }

  updateQuad(id: string, quad: Quad): void {
    this.mutatePrint(id, (p) => ({ ...p, quad, confidence: null }));
    this.schedulePreview(id, 200);
  }

  rotate(id: string, delta: 1 | -1): void {
    this.mutatePrint(id, (p) => ({ ...p, rotation: (p.rotation + delta + 4) % 4 }));
    this.schedulePreview(id, 0);
  }

  toggleIncluded(id: string): void {
    this.mutatePrint(id, (p) => ({ ...p, included: !p.included }));
  }

  remove(id: string): void {
    const job = this.requireJob();
    if (job.prints.find((p) => p.id === id)?.saved) return; // saved prints stay on record
    this.commitJob({ ...job, prints: job.prints.filter((p) => p.id !== id) });
    const previews = { ...this.#snap.previews };
    if (previews[id]) URL.revokeObjectURL(previews[id]);
    delete previews[id];
    this.set({ previews, selectedId: null });
  }

  /** Adds a centred rectangle covering ~40% of the image for the user to adjust. */
  addPrint(): void {
    const size = this.#snap.imageSize;
    if (!size) return;
    const w = size.width * 0.4, h = size.height * 0.4, x = (size.width - w) / 2, y = (size.height - h) / 2;
    const quad: Quad = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    const rec = SplitSession.printRecord(quad, null);
    this.commitJob({ ...this.requireJob(), prints: [...this.requireJob().prints, rec] });
    this.set({ selectedId: rec.id });
    this.schedulePreview(rec.id, 0);
  }

  // ---- saving ------------------------------------------------------------------

  /** Uploads every included, not-yet-saved print as a new item. Idempotent across retries. */
  async save(matchSourceDate: boolean): Promise<void> {
    const item = this.#snap.item;
    if (!item) return;
    let job = this.commitJob({ ...this.requireJob(), status: "saving" });
    const todo = job.prints.filter((p) => p.included && !p.saved);
    let done = 0;
    this.set({ phase: { name: "saving", done, total: todo.length } });

    for (const print of todo) {
      // Paragraph: render full resolution and upload through the bound tab.
      const index = job.prints.findIndex((p) => p.id === print.id) + 1;
      const fileName = SplitSession.outputName(item.fileName, index);
      try {
        const blob = await this.#worker.render(print.quad, print.rotation, false);
        const bytesBase64 = Base64.encode(new Uint8Array(await blob.arrayBuffer()));
        const tabId = await this.photosTab();
        const created = await Messenger.toPhotosTab(tabId, {
          type: "photos.uploadPhoto",
          expectedEmail: this.#snap.params.email,
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

  /** Renders included prints and triggers local downloads (no library change). */
  async downloadAll(): Promise<void> {
    const job = this.requireJob();
    for (const [i, p] of job.prints.entries()) {
      if (!p.included) continue;
      const blob = await this.#worker.render(p.quad, p.rotation, false);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = SplitSession.outputName(this.#snap.item?.fileName ?? null, i + 1);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
  }

  // ---- internals -----------------------------------------------------------------

  private async photosTab(): Promise<number> {
    const { email, tabId } = this.#snap.params;
    return (await Messenger.toBackground({ type: "photos.resolveTab", email, preferredTabId: tabId })).tabId;
  }

  private schedulePreview(id: string, delayMs: number): void {
    const prev = this.#previewTimers.get(id);
    if (prev) clearTimeout(prev);
    this.#previewTimers.set(id, setTimeout(() => void this.renderPreview(id), delayMs));
  }

  private async renderPreview(id: string): Promise<void> {
    const print = this.#snap.job?.prints.find((p) => p.id === id);
    if (!print) return;
    try {
      const blob = await this.#worker.render(print.quad, print.rotation, true);
      const previews = { ...this.#snap.previews };
      if (previews[id]) URL.revokeObjectURL(previews[id]);
      previews[id] = URL.createObjectURL(blob);
      this.set({ previews });
    } catch (err) {
      this.mutatePrint(id, (p) => ({ ...p, error: PixError.wrap(err, ErrorCode.InvalidGeometry, "Preview failed").toJSON() }));
    }
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
    if (!this.#snap.job) throw new PixError(ErrorCode.JobNotFound, "No split job is active");
    return this.#snap.job;
  }

  private requireStore(): JobStore {
    if (!this.#store) throw new PixError(ErrorCode.StorageFailed, "Storage not open");
    return this.#store;
  }

  private fail(err: unknown): void {
    const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Unexpected failure");
    console.error("[pixlixir]", e.toJSON());
    this.set({ phase: { name: "failed", error: e.toJSON() } });
  }

  static printRecord(quad: Quad, confidence: number | null): SplitPrintRecord {
    return { id: crypto.randomUUID(), quad: quad.map((p: Point) => ({ x: p.x, y: p.y })) as Quad, rotation: 0, included: true, confidence, saved: null, error: null };
  }

  static outputName(sourceName: string | null, index: number): string {
    const base = (sourceName ?? "scan").replace(/\.[^.]+$/, "").replace(/[^\w\- .]+/g, "_").slice(0, 80) || "scan";
    return `${base}_photo-${String(index).padStart(2, "0")}.jpg`;
  }
}
