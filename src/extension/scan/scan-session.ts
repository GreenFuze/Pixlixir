/**
 * Library scan page controller (UI-framework independent).
 *
 * Setup (what to look through, what to look for) -> scan (list items once, run the chosen
 * detectors; findings stream in) -> review (tick findings) -> bulk action (create the
 * panoramas one by one) -> results stay on the page and in the side panel's recent work.
 */

import type { AlbumRef, LibraryItem } from "../../domain/types.js";
import { LibraryCatalog } from "../../scan/library-catalog.js";
import { LibraryScanner, type ScanSummary } from "../../scan/library-scanner.js";
import { PanoramaDetector, type PanoramaCandidate } from "../../scan/panorama-detector.js";
import type { DetectorId, ScanDetector } from "../../scan/scan-detector.js";
import { ScanScopes, type ScanScope, type ScanScopeKind } from "../../scan/scan-scope.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { CanvasCodec } from "../editor/canvas-codec.js";
import { EditorSession } from "../editor/editor-session.js";
import { PanoramaWorkerClient } from "../editor/panorama/panorama-client.js";
import { PhotosGateway } from "../editor/photos-gateway.js";
import { Messenger } from "../messaging/protocol.js";
import { JobStore, type PanoramaJob } from "../storage/job-store.js";
import { SCAN_SELECTION_PREFIX } from "../tools.js";
import { PanoramaBulkCreator } from "./panorama-bulk-creator.js";
import { EngineOverlapChecker } from "./engine-overlap-checker.js";

export interface ScanParams {
  tabId: number;
  email: string;
  /** chrome.storage.session id of a selection handed over by the Photos tab. */
  selectionId: string | null;
  /** Album open in the Photos tab when the scan was started. */
  albumKey: string | null;
}

export type CandidateStatus = "found" | "queued" | "working" | "created" | "failed";

export interface CandidateView {
  candidate: PanoramaCandidate;
  previewUrl: string | null;
  selected: boolean;
  status: CandidateStatus;
  step: string | null;
  result: { webUrl: string; width: number; height: number; albums: string[]; problems: string[]; skipped: number; warnings: string[] } | null;
  error: SerializedError | null;
}

export type ScanPhase =
  | { name: "setup" }
  | { name: "scanning"; step: string; done: number | null; total: number | null }
  | { name: "review" }
  | { name: "creating"; done: number; total: number }
  | { name: "failed"; error: SerializedError };

export interface ScanSnapshot {
  params: ScanParams;
  phase: ScanPhase;
  scopeKind: ScanScopeKind;
  /** yyyy-mm-dd, local dates. */
  from: string;
  to: string;
  albumKey: string | null;
  albums: { status: "idle" | "loading" | "ready" | "failed"; items: AlbumRef[]; error: SerializedError | null };
  selection: string[];
  detectors: Record<DetectorId, boolean>;
  summary: ScanSummary | null;
  /** What the last scan looked through, in words. */
  scopeLabel: string;
  scanError: SerializedError | null;
  candidates: CandidateView[];
  thumbs: Record<string, string>;
  /** Engine stage while previews/panoramas are being stitched. */
  progress: string | null;
}

export class ScanSession extends EditorSession<ScanSnapshot> {
  static readonly THUMB_SIDE = 160;

  readonly #gateway: PhotosGateway;
  readonly #worker: PanoramaWorkerClient;
  #store: JobStore | null = null;
  #scan: AbortController | null = null;
  #stopCreating = false;
  #nextKey = 1;

  constructor(params: ScanParams) {
    const today = new Date();
    const monthAgo = new Date(today.getTime() - 30 * 86_400_000);
    super({
      params,
      phase: { name: "setup" },
      scopeKind: params.albumKey ? "album" : params.selectionId ? "selection" : "dateRange",
      from: ScanSession.isoDate(monthAgo),
      to: ScanSession.isoDate(today),
      albumKey: params.albumKey,
      albums: { status: "idle", items: [], error: null },
      selection: [],
      detectors: { panorama: true },
      summary: null,
      scopeLabel: "",
      scanError: null,
      candidates: [],
      thumbs: {},
      progress: null,
    });
    this.#gateway = new PhotosGateway(params.email, params.tabId);
    this.#worker = new PanoramaWorkerClient((stage) => this.set({ progress: stage }));
  }

  static paramsFromUrl(search: string): ScanParams {
    const q = new URLSearchParams(search);
    const tabId = Number(q.get("tab"));
    const email = q.get("email") ?? "";
    if (!Number.isInteger(tabId) || !email.includes("@")) {
      throw new PixError(ErrorCode.InvalidMessage, "The scan was opened without a Google Photos tab.", { tabId, hasEmail: email.length > 0 });
    }
    return { tabId, email, selectionId: q.get("sel"), albumKey: q.get("album") };
  }

  dispose(): void {
    this.#scan?.abort();
    this.#worker.dispose();
    this.#store?.close();
    this.revokeAll();
  }

  // ---- setup -------------------------------------------------------------------

  async init(): Promise<void> {
    try {
      // Paragraph: storage, the handed-over selection, and albums when one is preselected.
      this.#store = await JobStore.open();
      const { selectionId } = this.snapshot.params;
      if (selectionId) {
        const k = SCAN_SELECTION_PREFIX + selectionId;
        const got = await chrome.storage.session.get(k);
        const keys = got[k];
        if (!Array.isArray(keys)) throw new PixError(ErrorCode.InvalidMessage, "The selected photos are no longer available. Start the scan again from Google Photos.");
        this.set({ selection: keys.map(String) });
      }
      if (this.snapshot.scopeKind === "album") await this.loadAlbums();
    } catch (err) {
      this.fail(err);
    }
  }

  setScopeKind(kind: ScanScopeKind): void {
    this.set({ scopeKind: kind, scanError: null });
    if (kind === "album" && this.snapshot.albums.status === "idle") void this.loadAlbums();
  }

  setDates(from: string, to: string): void {
    this.set({ from, to, scanError: null });
  }

  setAlbum(albumKey: string): void {
    this.set({ albumKey, scanError: null });
  }

  toggleDetector(id: DetectorId): void {
    this.set({ detectors: { ...this.snapshot.detectors, [id]: !this.snapshot.detectors[id] } });
  }

  async loadAlbums(): Promise<void> {
    this.set({ albums: { status: "loading", items: [], error: null } });
    try {
      const items = await this.#gateway.allAlbums();
      this.set({ albums: { status: "ready", items, error: null } });
    } catch (err) {
      this.set({ albums: { status: "failed", items: [], error: EditorSession.failure(err) } });
    }
  }

  /** The scope as chosen in the form. */
  scope(): ScanScope {
    const s = this.snapshot;
    switch (s.scopeKind) {
      case "library":
        return { kind: "library" };
      case "selection":
        return { kind: "selection", mediaKeys: s.selection };
      case "album": {
        const album = s.albums.items.find((a) => a.mediaKey === s.albumKey);
        if (album) return { kind: "album", album };
        // The album open in Google Photos may not be in the list (e.g. shared with you by someone else).
        if (s.albumKey && s.albumKey === s.params.albumKey) return { kind: "album", album: { mediaKey: s.albumKey, title: "The album open in Google Photos", shared: false } };
        throw new PixError(ErrorCode.InvalidMessage, "Choose an album to scan.");
      }
      case "dateRange":
        return { kind: "dateRange", fromMs: ScanSession.localDayStart(s.from), toMs: ScanSession.localDayStart(s.to) + 86_400_000 - 1 };
    }
  }

  // ---- scanning ----------------------------------------------------------------

  async startScan(): Promise<void> {
    // Paragraph: fresh state, chosen detectors.
    this.revokeAll();
    this.set({ candidates: [], thumbs: {}, summary: null, scanError: null });
    const ctrl = new AbortController();
    this.#scan = ctrl;
    try {
      const scope = ScanScopes.validate(this.scope());
      this.set({ scopeLabel: ScanScopes.describe(scope) });
      if (!this.snapshot.detectors.panorama) throw new PixError(ErrorCode.InvalidMessage, "Choose at least one thing to look for.");
      const saved = await this.store().savedPanoramas(this.snapshot.params.email);
      const checker = new EngineOverlapChecker(this.#gateway, this.#worker, () => this.#nextKey++, (mk, blob) => this.keepThumb(mk, blob));
      const detectors: ScanDetector[] = [new PanoramaDetector(checker, (items) => ScanSession.alreadyMade(saved, items)) as ScanDetector];

      // Paragraph: run; findings appear as they are found.
      this.set({ phase: { name: "scanning", step: "Starting", done: null, total: null } });
      const scanner = new LibraryScanner(new LibraryCatalog(this.#gateway), detectors);
      const summary = await scanner.run(scope, {
        signal: ctrl.signal,
        progress: (step, done, total) => this.set({ phase: { name: "scanning", step, done: done ?? null, total: total ?? null } }),
      }, (finding) => this.addCandidate(finding as PanoramaCandidate));
      this.set({ phase: { name: "review" }, summary, progress: null });
    } catch (err) {
      const e = EditorSession.toError(err, "The scan failed");
      // A stopped scan keeps what it found so far.
      this.set({ phase: this.snapshot.candidates.length > 0 ? { name: "review" } : { name: "setup" }, scanError: e.code === ErrorCode.Cancelled ? null : e.toJSON(), progress: null });
    } finally {
      this.#scan = null;
    }
  }

  stopScan(): void {
    this.#scan?.abort();
  }

  newScan(): void {
    this.revokeAll();
    this.set({ phase: { name: "setup" }, candidates: [], thumbs: {}, summary: null, scanError: null });
  }

  // ---- review --------------------------------------------------------------------

  toggleCandidate(id: string): void {
    this.patchCandidate(id, (c) => (c.status === "found" || c.status === "failed" ? { selected: !c.selected } : {}));
  }

  selectAll(selected: boolean): void {
    this.set({ candidates: this.snapshot.candidates.map((c) => (c.status === "found" || c.status === "failed" ? { ...c, selected } : c)) });
  }

  selectedCount(): number {
    return this.snapshot.candidates.filter((c) => c.selected && (c.status === "found" || c.status === "failed")).length;
  }

  /** Opens one group in the Create-panorama editor (to fine-tune and save it by hand). */
  async openInEditor(id: string): Promise<void> {
    const c = this.view(id);
    try {
      const tabId = await this.photosTab(this.snapshot.params.email, this.snapshot.params.tabId);
      await Messenger.toBackground({ type: "panel.openTool", tool: "panorama", tabId, mediaKeys: c.candidate.mediaKeys });
    } catch (err) {
      this.patchCandidate(id, () => ({ error: EditorSession.failure(err) }));
    }
  }

  // ---- bulk creation -----------------------------------------------------------------

  /** Creates every ticked panorama, one at a time; each is saved as a new item. */
  async createSelected(): Promise<void> {
    // Paragraph: queue the ticked groups.
    const todo = this.snapshot.candidates.filter((c) => c.selected && (c.status === "found" || c.status === "failed")).map((c) => c.candidate.id);
    if (todo.length === 0) return;
    this.#stopCreating = false;
    this.set({ candidates: this.snapshot.candidates.map((c) => (todo.includes(c.candidate.id) ? { ...c, status: "queued", error: null } : c)), phase: { name: "creating", done: 0, total: todo.length } });
    const creator = new PanoramaBulkCreator(this.#gateway, this.#worker, this.store(), () => this.#nextKey++, crypto.randomUUID(), (blob) => CanvasCodec.thumbnail(blob, ScanSession.THUMB_SIDE));

    // Paragraph: one panorama at a time (bounded memory); a failure doesn't stop the others.
    for (const [i, id] of todo.entries()) {
      if (this.#stopCreating) {
        this.patchCandidate(id, () => ({ status: "found", step: null }));
        continue;
      }
      this.patchCandidate(id, () => ({ status: "working", step: "Starting" }));
      try {
        const r = await creator.create(this.view(id).candidate, (step) => this.patchCandidate(id, () => ({ step })));
        this.patchCandidate(id, () => ({
          status: "created", step: null, selected: false, error: null,
          result: { webUrl: r.job.saved!.webUrl, width: r.width, height: r.height, albums: r.published.albumsAdded.map((a) => a.title), problems: r.published.problems.map((p) => p.message), skipped: r.skipped.length, warnings: r.warnings },
        }));
      } catch (err) {
        const e = EditorSession.toError(err, "Could not create this panorama");
        this.patchCandidate(id, () => ({ status: "failed", step: null, error: e.toJSON() }));
        if (e.code === ErrorCode.AccountMismatch || e.code === ErrorCode.TabNotBound || e.code === ErrorCode.SessionUnavailable) this.#stopCreating = true;
      }
      this.set({ phase: { name: "creating", done: i + 1, total: todo.length }, progress: null });
    }
    this.set({ phase: { name: "review" }, progress: null });
  }

  /** Stops after the panorama being built now. */
  stopCreating(): void {
    this.#stopCreating = true;
  }

  // ---- internals -----------------------------------------------------------------

  private addCandidate(c: PanoramaCandidate): void {
    const usable = c.preview !== null && c.alreadyMade === null;
    const view: CandidateView = { candidate: c, previewUrl: c.preview ? URL.createObjectURL(c.preview.image) : null, selected: usable, status: "found", step: null, result: null, error: null };
    this.set({ candidates: [...this.snapshot.candidates, view] });
  }

  private async keepThumb(mediaKey: string, blob: Blob): Promise<void> {
    if (this.snapshot.thumbs[mediaKey]) return;
    const url = URL.createObjectURL(await CanvasCodec.thumbnail(blob, ScanSession.THUMB_SIDE));
    this.set({ thumbs: { ...this.snapshot.thumbs, [mediaKey]: url } });
  }

  private view(id: string): CandidateView {
    const c = this.snapshot.candidates.find((x) => x.candidate.id === id);
    if (!c) throw new PixError(ErrorCode.Internal, "Unknown scan finding", { id });
    return c;
  }

  private patchCandidate(id: string, patch: (c: CandidateView) => Partial<CandidateView>): void {
    this.set({ candidates: this.snapshot.candidates.map((c) => (c.candidate.id === id ? { ...c, ...patch(c) } : c)) });
  }

  private store(): JobStore {
    if (!this.#store) throw new PixError(ErrorCode.StorageFailed, "Pixlixir storage is not open");
    return this.#store;
  }

  private revokeAll(): void {
    for (const c of this.snapshot.candidates) if (c.previewUrl) URL.revokeObjectURL(c.previewUrl);
    for (const url of Object.values(this.snapshot.thumbs)) URL.revokeObjectURL(url);
  }

  /**
   * A saved panorama counts as "already made" when it used at least half of these photos.
   * Compared by dedup key (album listings use album-specific media keys); jobs saved
   * before dedup keys were recorded are compared by media key.
   */
  static alreadyMade(saved: readonly PanoramaJob[], items: readonly LibraryItem[]): { webUrl: string } | null {
    for (const job of saved) {
      if (!job.saved) continue;
      const byDedup = job.usedDedupKeys !== undefined && job.usedDedupKeys.length > 0;
      const used = new Set(byDedup ? job.usedDedupKeys : job.usedMediaKeys.length > 0 ? job.usedMediaKeys : job.sourceMediaKeys);
      const shared = items.filter((i) => used.has(byDedup ? i.dedupKey : i.mediaKey)).length;
      if (shared * 2 >= items.length) return { webUrl: job.saved.webUrl };
    }
    return null;
  }

  static isoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** Midnight (local time) of a yyyy-mm-dd date, as epoch ms. */
  static localDayStart(iso: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) throw new PixError(ErrorCode.InvalidMessage, "Enter a valid date.", { value: iso });
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }
}
