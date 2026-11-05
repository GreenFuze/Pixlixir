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
import { PanoramaDetector, type PanoramaCandidate, type SavedSequence } from "../../scan/panorama-detector.js";
import { ScanEta } from "../../scan/scan-eta.js";
import type { DetectorId, ScanDetector } from "../../scan/scan-detector.js";
import { ScanScopes, type ScanScope, type ScanScopeKind } from "../../scan/scan-scope.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { CanvasCodec } from "../editor/canvas-codec.js";
import { EditorSession } from "../editor/editor-session.js";
import { PanoramaWorkerClient } from "../editor/panorama/panorama-client.js";
import { PanoramaSession } from "../editor/panorama/panorama-session.js";
import { PhotosGateway } from "../editor/photos-gateway.js";
import { JobStore, type PanoramaJob } from "../storage/job-store.js";
import { ScanStore } from "../storage/scan-store.js";
import { SCAN_SELECTION_PREFIX, type ScanHandover } from "../tools.js";
import { PanoramaBulkCreator } from "./panorama-bulk-creator.js";
import { EngineOverlapChecker } from "./engine-overlap-checker.js";

export interface ScanParams {
  tabId: number;
  email: string;
  /** One-time chrome.storage.session id set by the service worker; holds the handed-over selection. */
  selectionId: string;
  /** Album open in the Photos tab when the scan was started. */
  albumKey: string | null;
}

export type CandidateStatus = "found" | "queued" | "working" | "created" | "failed";

export interface CandidateView {
  candidate: PanoramaCandidate;
  previewUrl: string;
  selected: boolean;
  status: CandidateStatus;
  step: string | null;
  result: { webUrl: string; width: number; height: number; albums: string[]; problems: string[]; skipped: number; warnings: string[] } | null;
  error: SerializedError | null;
}

export type ScanPhase =
  | { name: "setup" }
  | { name: "scanning"; step: string; done: number | null; total: number | null; secondsLeft: number | null }
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
  /** Ignore saved results and check every photo again. */
  recheck: boolean;
  summary: ScanSummary | null;
  /** What the last scan looked through, in words. */
  scopeLabel: string;
  scanError: SerializedError | null;
  candidates: CandidateView[];
  thumbs: Record<string, string>;
  /** Engine stage while previews/panoramas are being stitched. */
  progress: string | null;
  /** Asking whether to stop running work before closing. */
  confirmingClose: boolean;
  /** One group open in the Create-panorama editor, inside this modal. */
  editor: { candidateId: string; session: PanoramaSession } | null;
}

export class ScanSession extends EditorSession<ScanSnapshot> {
  static readonly THUMB_SIDE = 160;

  readonly #gateway: PhotosGateway;
  readonly #worker: PanoramaWorkerClient;
  #store: JobStore | null = null;
  #results: ScanStore | null = null;
  #scan: AbortController | null = null;
  #stopCreating = false;
  #nextKey = 1;
  #lastActivity: string | null = null;

  constructor(params: ScanParams) {
    const today = new Date();
    const monthAgo = new Date(today.getTime() - 30 * 86_400_000);
    super({
      params,
      phase: { name: "setup" },
      scopeKind: params.albumKey ? "album" : "dateRange",
      from: ScanSession.isoDate(monthAgo),
      to: ScanSession.isoDate(today),
      albumKey: params.albumKey,
      albums: { status: "idle", items: [], error: null },
      selection: [],
      detectors: { panorama: true },
      recheck: false,
      summary: null,
      scopeLabel: "",
      scanError: null,
      candidates: [],
      thumbs: {},
      progress: null,
      confirmingClose: false,
      editor: null,
    });
    this.#gateway = new PhotosGateway(params.email, params.tabId);
    this.#worker = new PanoramaWorkerClient((stage) => this.set({ progress: stage }));
  }

  static paramsFromUrl(search: string): ScanParams {
    const q = new URLSearchParams(search);
    const tabId = Number(q.get("tab"));
    const email = q.get("email") ?? "";
    const selectionId = q.get("sel");
    if (!Number.isInteger(tabId) || !email.includes("@") || !selectionId) {
      throw new PixError(ErrorCode.InvalidMessage, "Start the scan from the Pixlixir menu in Google Photos.", { tabId, hasEmail: email.length > 0, hasSession: selectionId !== null });
    }
    return { tabId, email, selectionId, albumKey: q.get("album") };
  }

  dispose(): void {
    this.#scan?.abort();
    this.snapshot.editor?.session.dispose();
    this.#worker.dispose();
    this.#store?.close();
    this.#results?.close();
    this.revokeAll();
  }

  // ---- setup -------------------------------------------------------------------

  async init(): Promise<void> {
    try {
      // Paragraph: this page may only run when opened through the service worker (one-time id).
      this.#store = await JobStore.open();
      this.#results = await ScanStore.open();
      const k = SCAN_SELECTION_PREFIX + this.snapshot.params.selectionId;
      const handover = (await chrome.storage.session.get(k))[k] as ScanHandover | undefined;
      if (!handover || handover.accountEmail !== this.snapshot.params.email) throw new PixError(ErrorCode.InvalidMessage, "Start the scan from the Pixlixir menu in Google Photos.");
      await chrome.storage.session.remove(k);
      const keys = handover.mediaKeys;

      // Paragraph: a selection is the most specific scope; else a preselected album.
      if (keys.length > 0) this.set({ selection: keys, scopeKind: "selection" });
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

  toggleRecheck(): void {
    this.set({ recheck: !this.snapshot.recheck });
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
      const checker = new EngineOverlapChecker(this.#gateway, this.#worker, () => this.#nextKey++, (blob) => CanvasCodec.thumbnail(blob, ScanSession.THUMB_SIDE));
      const cache = this.results().cache<SavedSequence>(this.snapshot.params.email, "panorama");
      const detectors: ScanDetector[] = [new PanoramaDetector(checker, (items) => ScanSession.alreadyMade(saved, items), cache, this.snapshot.recheck) as ScanDetector];

      // Paragraph: run; findings appear as they are found.
      this.set({ phase: { name: "scanning", step: "Starting", done: null, total: null, secondsLeft: null } });
      const eta = new ScanEta();
      const scanner = new LibraryScanner(new LibraryCatalog(this.#gateway), detectors);
      const summary = await scanner.run(scope, {
        signal: ctrl.signal,
        progress: (step, done, total) => {
          const counted = done !== undefined && total !== undefined;
          this.set({ phase: { name: "scanning", step, done: done ?? null, total: total ?? null, secondsLeft: counted ? eta.update(done, total, Date.now()) : null } });
          this.reportActivity(counted && total > 0 ? `Scanning ${Math.floor((done / total) * 100)}%` : "Scanning…");
        },
      }, (finding) => this.addCandidate(finding as PanoramaCandidate));
      this.set({ phase: { name: "review" }, summary, progress: null });
      this.reportActivity("Scan results");
    } catch (err) {
      const e = EditorSession.toError(err, "The scan failed");
      // A stopped scan keeps what it found so far.
      const found = this.snapshot.candidates.length > 0;
      this.set({ phase: found ? { name: "review" } : { name: "setup" }, scanError: e.code === ErrorCode.Cancelled ? null : e.toJSON(), progress: null });
      this.reportActivity(found ? "Scan results" : null);
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
    this.reportActivity(null);
  }

  // ---- the modal -------------------------------------------------------------------

  /** Keeps working in the background; the chip on the Photos tab shows progress and brings it back. */
  minimize(): void {
    this.set({ confirmingClose: false });
    void this.#gateway.minimizeModal().catch((e: unknown) => this.set({ scanError: EditorSession.failure(e) }));
  }

  /** Closes right away unless work is running, which needs a confirmation first. */
  requestClose(): void {
    const running = this.snapshot.phase.name === "scanning" || this.snapshot.phase.name === "creating";
    if (running) this.set({ confirmingClose: true });
    else this.close();
  }

  cancelClose(): void {
    this.set({ confirmingClose: false });
  }

  /** Removes the modal (and this page with it, which stops any running work). */
  close(): void {
    this.#scan?.abort();
    void this.#gateway.closeModal().catch((e: unknown) => this.set({ confirmingClose: false, scanError: EditorSession.failure(e) }));
  }

  private reportActivity(label: string | null): void {
    if (label === this.#lastActivity) return;
    this.#lastActivity = label;
    this.#gateway.reportActivity(label).catch((e: unknown) => console.error("[pixlixir] could not update the chip", e));
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

  /** Opens one group in the Create-panorama editor, in this modal (to fine-tune and save it by hand). */
  async openInEditor(id: string): Promise<void> {
    const { params } = this.snapshot;
    try {
      const tabId = await this.photosTab(params.email, params.tabId);
      const session = new PanoramaSession({ tabId, email: params.email, mediaKeys: this.view(id).candidate.mediaKeys });
      this.set({ editor: { candidateId: id, session } });
      await session.init();
    } catch (err) {
      this.patchCandidate(id, () => ({ error: EditorSession.failure(err) }));
    }
  }

  /** Back to the results; a panorama saved in the editor counts as created. */
  closeEditor(): void {
    const editor = this.snapshot.editor;
    if (!editor) return;
    const { phase, job, published } = editor.session.snapshot;
    if (phase.name === "saving") return;
    if (phase.name === "saved" && job?.saved && published) {
      const { webUrl, width, height } = job.saved;
      this.patchCandidate(editor.candidateId, () => ({
        status: "created", selected: false, error: null,
        result: { webUrl, width, height, albums: published.albumsAdded.map((a) => a.title), problems: published.problems.map((p) => p.message), skipped: 0, warnings: [] },
      }));
    }
    editor.session.dispose();
    this.set({ editor: null });
  }

  // ---- bulk creation -----------------------------------------------------------------

  /** Creates every ticked panorama, one at a time; each is saved as a new item. */
  async createSelected(): Promise<void> {
    // Paragraph: queue the ticked groups.
    const todo = this.snapshot.candidates.filter((c) => c.selected && (c.status === "found" || c.status === "failed")).map((c) => c.candidate.id);
    if (todo.length === 0) return;
    this.#stopCreating = false;
    this.set({ candidates: this.snapshot.candidates.map((c) => (todo.includes(c.candidate.id) ? { ...c, status: "queued", error: null } : c)), phase: { name: "creating", done: 0, total: todo.length } });
    this.reportActivity(`Creating 1/${todo.length}`);
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
      this.reportActivity(`Creating ${Math.min(i + 2, todo.length)}/${todo.length}`);
    }
    this.set({ phase: { name: "review" }, progress: null });
    this.reportActivity("Scan results");
  }

  /** Stops after the panorama being built now. */
  stopCreating(): void {
    this.#stopCreating = true;
  }

  // ---- internals -----------------------------------------------------------------

  private addCandidate(c: PanoramaCandidate): void {
    const view: CandidateView = { candidate: c, previewUrl: URL.createObjectURL(c.preview.image), selected: c.alreadyMade === null, status: "found", step: null, result: null, error: null };
    const thumbs = { ...this.snapshot.thumbs };
    for (const [key, blob] of Object.entries(c.thumbs)) thumbs[key] ??= URL.createObjectURL(blob);
    this.set({ candidates: [...this.snapshot.candidates, view], thumbs });
  }

  private view(id: string): CandidateView {
    const c = this.snapshot.candidates.find((x) => x.candidate.id === id);
    if (!c) throw new PixError(ErrorCode.Internal, "Unknown scan finding", { id });
    return c;
  }

  private patchCandidate(id: string, patch: (c: CandidateView) => Partial<CandidateView>): void {
    this.set({ candidates: this.snapshot.candidates.map((c) => (c.candidate.id === id ? { ...c, ...patch(c) } : c)) });
  }

  private results(): ScanStore {
    if (!this.#results) throw new PixError(ErrorCode.StorageFailed, "Saved scan results are not open");
    return this.#results;
  }

  private store(): JobStore {
    if (!this.#store) throw new PixError(ErrorCode.StorageFailed, "Pixlixir storage is not open");
    return this.#store;
  }

  private revokeAll(): void {
    for (const c of this.snapshot.candidates) URL.revokeObjectURL(c.previewUrl);
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
