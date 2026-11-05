/**
 * Split several scans at once. Scans are analysed one after another (one original in memory
 * at a time); the user can review any of them in the normal Split editor, then save all.
 * Edits live in each scan's job record, so a scan can be closed and reopened at no loss.
 */

import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import type { SplitJob } from "../storage/job-store.js";
import { TOOLS } from "../tools.js";
import { EditorSession, type EditorParams } from "./editor-session.js";

/** What the batch needs from one scan's session (SplitSession). */
export interface BatchScan {
  readonly snapshot: { phase: { name: string; error?: SerializedError }; job: SplitJob | null; item: { fileName: string | null } | null };
  subscribe(fn: (s: BatchScan["snapshot"]) => void): () => void;
  init(): Promise<void>;
  save(matchSourceDate: boolean): Promise<void>;
  thumbnail(): Promise<Blob>;
  dispose(): void;
}

export type BatchEntryStatus = "waiting" | "analysing" | "ready" | "saving" | "saved" | "partial" | "failed";

export interface BatchEntry {
  mediaKey: string;
  status: BatchEntryStatus;
  fileName: string | null;
  thumbUrl: string | null;
  /** Photos found in this scan, still to save, and saved. */
  found: number;
  pending: number;
  saved: number;
  error: SerializedError | null;
}

export type BatchPhase = { name: "working" } | { name: "saving"; done: number; total: number } | { name: "failed"; error: SerializedError };

export interface BatchSnapshot<S> {
  params: EditorParams;
  phase: BatchPhase;
  entries: BatchEntry[];
  openIndex: number;
  /** The session of the scan being reviewed (null while its analysis is still queued). */
  current: S | null;
}

export class SplitBatch<S extends BatchScan> extends EditorSession<BatchSnapshot<S>> {
  readonly #background = new Set<S>();
  #unsubscribe: (() => void) | null = null;

  constructor(
    params: EditorParams,
    private readonly createScan: (mediaKey: string) => S,
  ) {
    super({
      params,
      phase: { name: "working" },
      entries: params.mediaKeys.map((mediaKey) => ({ mediaKey, status: "waiting", fileName: null, thumbUrl: null, found: 0, pending: 0, saved: 0, error: null })),
      openIndex: 0,
      current: null,
    });
  }

  static paramsFromUrl(search: string): EditorParams {
    return EditorSession.parseParams(search, { min: TOOLS.split.minPhotos, max: TOOLS.split.maxPhotos });
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.snapshot.current?.dispose();
    for (const scan of this.#background) scan.dispose();
    for (const e of this.snapshot.entries) if (e.thumbUrl) URL.revokeObjectURL(e.thumbUrl);
  }

  /** Analyses every scan, the one being reviewed first. */
  async init(): Promise<void> {
    try {
      for (let i = this.nextToAnalyse(); i !== null; i = this.nextToAnalyse()) await this.analyse(i);
    } catch (err) {
      this.fail(err);
    }
  }

  /** True once every scan has been analysed. */
  get analysed(): boolean {
    return this.snapshot.entries.every((e) => e.status !== "waiting" && e.status !== "analysing");
  }

  /** Photos still to save across all scans, and how many scans hold them. */
  totals(): { photos: number; scans: number; saved: number } {
    const withPending = this.snapshot.entries.filter((e) => e.pending > 0);
    return { photos: withPending.reduce((n, e) => n + e.pending, 0), scans: withPending.length, saved: this.snapshot.entries.reduce((n, e) => n + e.saved, 0) };
  }

  /** Reviews another scan; the current one's edits are already in its job record. */
  open(index: number): void {
    const { openIndex, phase, entries } = this.snapshot;
    if (index === openIndex || phase.name === "saving" || !entries[index]) return;
    this.detachCurrent();
    this.set({ openIndex: index });
    const status = entries[index].status;
    if (status === "waiting" || status === "analysing") return; // attached when its analysis runs or ends
    const scan = this.createScan(entries[index].mediaKey);
    this.attach(index, scan);
    void scan.init();
  }

  /** Saves every scan's included photos as new items, one scan at a time. */
  async saveAll(matchSourceDate: boolean): Promise<void> {
    if (!this.analysed) throw new PixError(ErrorCode.Internal, "Scans are still being analysed");
    const todo = this.snapshot.entries.flatMap((e, i) => (e.pending > 0 ? [i] : []));
    let done = 0;
    this.set({ phase: { name: "saving", done, total: todo.length } });

    for (const i of todo) {
      // Paragraph: reuse the open session, or load the scan just for saving.
      this.patch(i, { status: "saving" });
      const isOpen = i === this.snapshot.openIndex && this.snapshot.current !== null;
      const scan = isOpen ? this.snapshot.current! : this.createScan(this.snapshot.entries[i]!.mediaKey);
      if (!isOpen) {
        this.#background.add(scan);
        await scan.init();
      }
      if (scan.snapshot.phase.name !== "failed") await scan.save(matchSourceDate);
      this.absorb(i, scan);
      const fatal = SplitBatch.fatalError(scan);
      if (!isOpen) {
        scan.dispose();
        this.#background.delete(scan);
      }
      this.set({ phase: { name: "saving", done: ++done, total: todo.length } });

      // Paragraph: account or session problems affect every remaining scan.
      if (fatal) break;
    }
    this.set({ phase: { name: "working" } });
  }

  // ---- internals -----------------------------------------------------------------

  private nextToAnalyse(): number | null {
    const { entries, openIndex } = this.snapshot;
    if (entries[openIndex]?.status === "waiting") return openIndex;
    const i = entries.findIndex((e) => e.status === "waiting");
    return i >= 0 ? i : null;
  }

  private async analyse(i: number): Promise<void> {
    // Paragraph: the scan being reviewed shows its loading steps; others run in the background.
    this.patch(i, { status: "analysing" });
    const scan = this.createScan(this.snapshot.entries[i]!.mediaKey);
    const reviewing = i === this.snapshot.openIndex && this.snapshot.current === null;
    if (reviewing) this.attach(i, scan);
    else this.#background.add(scan);
    await scan.init();
    this.absorb(i, scan);

    // Paragraph: thumbnail for the filmstrip (a missing one is reported, not fatal).
    if (scan.snapshot.phase.name !== "failed") {
      try {
        this.patch(i, { thumbUrl: URL.createObjectURL(await scan.thumbnail()) });
      } catch (err) {
        console.error("[pixlixir] could not make a scan thumbnail", err);
      }
    }

    // Paragraph: the user may have opened this scan meanwhile.
    if (!reviewing) {
      this.#background.delete(scan);
      if (i === this.snapshot.openIndex && this.snapshot.current === null) this.attach(i, scan);
      else scan.dispose();
    }
  }

  private attach(i: number, scan: S): void {
    this.#unsubscribe = scan.subscribe(() => this.absorb(i, scan));
    this.set({ current: scan });
  }

  private detachCurrent(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.snapshot.current?.dispose();
    this.set({ current: null });
  }

  /** Copies a scan's state into its entry. */
  private absorb(i: number, scan: S): void {
    const s = scan.snapshot;
    if (s.phase.name === "loading") return;
    if (s.phase.name === "failed") {
      this.patch(i, { status: "failed", error: s.phase.error ?? null, fileName: s.item?.fileName ?? null });
      return;
    }
    const prints = s.job?.prints ?? [];
    const saved = prints.filter((p) => p.saved).length;
    const pending = prints.filter((p) => p.included && !p.saved).length;
    const status: BatchEntryStatus = s.phase.name === "saving" ? "saving" : pending === 0 && saved > 0 ? "saved" : saved > 0 ? "partial" : prints.some((p) => p.error) ? "failed" : "ready";
    this.patch(i, { status, fileName: s.item?.fileName ?? null, found: prints.length, pending, saved, error: prints.find((p) => p.error)?.error ?? null });
  }

  private patch(i: number, patch: Partial<BatchEntry>): void {
    this.set({ entries: this.snapshot.entries.map((e, n) => (n === i ? { ...e, ...patch } : e)) });
  }

  private static fatalError(scan: BatchScan): boolean {
    const codes = [scan.snapshot.phase.error?.code, ...(scan.snapshot.job?.prints ?? []).map((p) => p.error?.code)];
    return codes.some((c) => c === ErrorCode.AccountMismatch || c === ErrorCode.TabNotBound || c === ErrorCode.SessionUnavailable);
  }
}
