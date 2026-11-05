/**
 * Library scan page controller (UI-framework independent).
 *
 * Setup (what to look through, what to look for) -> scan (list items once, run the chosen
 * detectors; findings stream in) -> review (tick findings) -> bulk action (create the
 * panoramas one by one) -> results stay on the page and in the side panel's recent work.
 */

import type { AlbumRef, LibraryItem } from "../../domain/types.js";
import { DateFixApplier, FilenameDateDetector, type DateFixFinding, type PlannedDate } from "../../scan/date-fix.js";
import { FilenameFormats } from "../../scan/filename-format.js";
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
import { Messenger } from "../messaging/protocol.js";
import { FormatStore } from "../storage/format-store.js";
import { JobStore, type DateFixJob, type PanoramaJob } from "../storage/job-store.js";
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

export interface DateFixView {
  finding: DateFixFinding;
  selected: boolean;
  fixed: boolean;
  thumbUrl: string | null;
}

export type ScanPhase =
  | { name: "setup" }
  | { name: "scanning"; step: string; done: number | null; total: number | null; secondsLeft: number | null }
  | { name: "review" }
  | { name: "creating"; done: number; total: number }
  | { name: "fixingDates"; done: number; total: number }
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
  dateFixes: DateFixView[];
  /** How many date rows are listed (the rest behind "Show more"). */
  dateFixesShown: number;
  dateFixError: SerializedError | null;
  /** A run that can be undone. */
  undoableDateFix: boolean;
  /** One group open in the Create-panorama editor, inside this modal. */
  editor: { candidateId: string; session: PanoramaSession } | null;
}

export class ScanSession extends EditorSession<ScanSnapshot> {
  static readonly THUMB_SIDE = 160;
  static readonly DATE_ROWS_PER_PAGE = 100;
  static readonly DATE_THUMB_SIDE = 96;

  readonly #gateway: PhotosGateway;
  readonly #worker: PanoramaWorkerClient;
  #store: JobStore | null = null;
  #results: ScanStore | null = null;
  #scan: AbortController | null = null;
  #stopCreating = false;
  #nextKey = 1;
  #lastActivity: string | null = null;
  #dateJob: DateFixJob | null = null;

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
      detectors: { panorama: true, dates: true },
      recheck: false,
      summary: null,
      scopeLabel: "",
      scanError: null,
      candidates: [],
      thumbs: {},
      progress: null,
      confirmingClose: false,
      dateFixes: [],
      dateFixesShown: ScanSession.DATE_ROWS_PER_PAGE,
      dateFixError: null,
      undoableDateFix: false,
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
    this.set({ candidates: [], thumbs: {}, summary: null, scanError: null, ...ScanSession.noDateFixes() });
    this.#dateJob = null;
    const ctrl = new AbortController();
    this.#scan = ctrl;
    try {
      const scope = ScanScopes.validate(this.scope());
      this.set({ scopeLabel: ScanScopes.describe(scope) });
      const detectors = await this.chosenDetectors();
      if (detectors.length === 0) throw new PixError(ErrorCode.InvalidMessage, "Choose at least one thing to look for.");

      // Paragraph: run; findings appear as they are found.
      this.set({ phase: { name: "scanning", step: "Starting", done: null, total: null, secondsLeft: null } });
      let eta = new ScanEta();
      let etaStep = "";
      const scanner = new LibraryScanner(new LibraryCatalog(this.#gateway), detectors);
      const summary = await scanner.run(scope, {
        signal: ctrl.signal,
        progress: (step, done, total) => {
          const counted = done !== undefined && total !== undefined;
          if (step !== etaStep) {
            eta = new ScanEta();
            etaStep = step;
          }
          this.set({ phase: { name: "scanning", step, done: done ?? null, total: total ?? null, secondsLeft: counted ? eta.update(done, total, Date.now()) : null } });
          this.reportActivity(counted && total > 0 ? `Scanning ${Math.floor((done / total) * 100)}%` : "Scanning…");
        },
      }, (finding) => (finding.detector === "dates" ? this.addDateFix(finding as DateFixFinding) : this.addCandidate(finding as PanoramaCandidate)));
      this.set({ phase: { name: "review" }, summary, progress: null });
      this.reportActivity("Scan results");
      void this.loadDateThumbs();
    } catch (err) {
      const e = EditorSession.toError(err, "The scan failed");
      // A stopped scan keeps what it found so far.
      const found = this.snapshot.candidates.length > 0 || this.snapshot.dateFixes.length > 0;
      this.set({ phase: found ? { name: "review" } : { name: "setup" }, scanError: e.code === ErrorCode.Cancelled ? null : e.toJSON(), progress: null });
      this.reportActivity(found ? "Scan results" : null);
    } finally {
      this.#scan = null;
    }
  }

  stopScan(): void {
    this.#scan?.abort();
  }

  /** Cheap checks first, so their findings appear before the stitching engine starts. */
  private async chosenDetectors(): Promise<ScanDetector[]> {
    const { params, detectors: chosen, recheck } = this.snapshot;
    const detectors: ScanDetector[] = [];
    if (chosen.dates) {
      const formats = new FilenameFormats(await new FormatStore(params.email).load());
      detectors.push(new FilenameDateDetector(this.#gateway, formats, this.results().cache<string>(params.email, "dates")) as ScanDetector);
    }
    if (chosen.panorama) {
      const saved = await this.store().savedPanoramas(params.email);
      const checker = new EngineOverlapChecker(this.#gateway, this.#worker, () => this.#nextKey++, (blob) => CanvasCodec.thumbnail(blob, ScanSession.THUMB_SIDE));
      const cache = this.results().cache<SavedSequence>(params.email, "panorama");
      detectors.push(new PanoramaDetector(checker, (items) => ScanSession.alreadyMade(saved, items), cache, recheck) as ScanDetector);
    }
    return detectors;
  }

  newScan(): void {
    this.revokeAll();
    this.#dateJob = null;
    this.set({ phase: { name: "setup" }, candidates: [], thumbs: {}, summary: null, scanError: null, ...ScanSession.noDateFixes() });
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
    const running = this.snapshot.phase.name === "scanning" || this.snapshot.phase.name === "creating" || this.snapshot.phase.name === "fixingDates";
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

  // ---- wrong dates ---------------------------------------------------------------------

  /** Opens this account's filename formats in a tab. The next scan uses them. */
  async openSettings(): Promise<void> {
    try {
      const { params } = this.snapshot;
      await Messenger.toBackground({ type: "panel.openSettings", tabId: await this.photosTab(params.email, params.tabId) });
    } catch (err) {
      this.set({ scanError: EditorSession.failure(err) });
    }
  }

  toggleDateFix(mediaKey: string): void {
    this.set({ dateFixes: this.snapshot.dateFixes.map((d) => (d.finding.item.mediaKey === mediaKey && !d.fixed ? { ...d, selected: !d.selected } : d)) });
  }

  selectAllDateFixes(selected: boolean): void {
    this.set({ dateFixes: this.snapshot.dateFixes.map((d) => (d.fixed ? d : { ...d, selected })) });
  }

  selectedDateFixes(): number {
    return this.snapshot.dateFixes.filter((d) => d.selected && !d.fixed).length;
  }

  showMoreDateFixes(): void {
    this.set({ dateFixesShown: this.snapshot.dateFixesShown + ScanSession.DATE_ROWS_PER_PAGE });
    void this.loadDateThumbs();
  }

  /** Changes the ticked dates in place. The old dates are saved first, so the run can be undone. */
  async fixSelectedDates(): Promise<void> {
    // Paragraph: the record comes before the first change.
    const views = this.snapshot.dateFixes.filter((d) => d.selected && !d.fixed);
    if (views.length === 0) return;
    const now = Date.now();
    let job: DateFixJob = await this.store().put<DateFixJob>({
      id: crypto.randomUUID(), kind: "dateFix", accountEmail: this.snapshot.params.email, sourceMediaKey: views[0]!.finding.item.mediaKey, status: "saving", error: null, createdAt: now, updatedAt: now,
      changes: views.map(({ finding: f }) => ({ mediaKey: f.item.mediaKey, dedupKey: f.item.dedupKey, fileName: f.fileName, oldTakenAtMs: f.item.takenAtMs, newTakenAtMs: f.newTakenAtMs, timezoneOffsetMs: f.item.timezoneOffsetMs, applied: false })),
    });
    this.#dateJob = job;

    // Paragraph: write and read back, batch by batch.
    const planned: PlannedDate[] = job.changes.map((c) => ({ mediaKey: c.mediaKey, dedupKey: c.dedupKey, takenAtMs: c.newTakenAtMs, timezoneOffsetMs: c.timezoneOffsetMs }));
    const applied = new Set<string>();
    this.#stopCreating = false;
    this.set({ dateFixError: null, phase: { name: "fixingDates", done: 0, total: planned.length } });
    try {
      await new DateFixApplier(this.#gateway).run(planned, () => this.#stopCreating, async (keys) => {
        for (const k of keys) applied.add(k);
        job = await this.store().put<DateFixJob>({ ...job, changes: job.changes.map((c) => (applied.has(c.mediaKey) ? { ...c, applied: true } : c)) });
        this.#dateJob = job;
        this.markDatesFixed(applied, true);
        this.set({ phase: { name: "fixingDates", done: applied.size, total: planned.length } });
        this.reportActivity(`Dates ${applied.size}/${planned.length}`);
      });
      job = await this.store().put<DateFixJob>({ ...job, status: applied.size === planned.length ? "done" : "partial" });
    } catch (err) {
      const e = EditorSession.toError(err, "Could not change the dates");
      job = await this.store().put<DateFixJob>({ ...job, status: applied.size > 0 ? "partial" : "failed", error: e.toJSON() });
      this.set({ dateFixError: e.toJSON() });
    }
    this.#dateJob = job;
    this.set({ phase: { name: "review" }, undoableDateFix: applied.size > 0 });
    this.reportActivity("Scan results");
  }

  /** Puts back the old dates of the last run. */
  async undoDateFixes(): Promise<void> {
    const original = this.#dateJob;
    if (!original) return;
    const done = original.changes.filter((c) => c.applied);
    const planned: PlannedDate[] = done.map((c) => ({ mediaKey: c.mediaKey, dedupKey: c.dedupKey, takenAtMs: c.oldTakenAtMs, timezoneOffsetMs: c.timezoneOffsetMs }));
    const restored = new Set<string>();
    this.#stopCreating = false;
    this.set({ dateFixError: null, phase: { name: "fixingDates", done: 0, total: planned.length } });
    try {
      await new DateFixApplier(this.#gateway).run(planned, () => false, (keys) => {
        for (const k of keys) restored.add(k);
        this.markDatesFixed(restored, false);
        this.set({ phase: { name: "fixingDates", done: restored.size, total: planned.length } });
      });
      this.#dateJob = await this.store().put<DateFixJob>({ ...original, status: "undone", changes: original.changes.map((c) => ({ ...c, applied: false })) });
      this.set({ undoableDateFix: false });
    } catch (err) {
      // Paragraph: what is still changed stays undoable.
      const e = EditorSession.toError(err, "Could not put the dates back");
      this.#dateJob = await this.store().put<DateFixJob>({ ...original, status: "partial", error: e.toJSON(), changes: original.changes.map((c) => (restored.has(c.mediaKey) ? { ...c, applied: false } : c)) });
      this.set({ dateFixError: e.toJSON() });
    }
    this.set({ phase: { name: "review" } });
  }

  private addDateFix(finding: DateFixFinding): void {
    this.set({ dateFixes: [...this.snapshot.dateFixes, { finding, selected: true, fixed: false, thumbUrl: null }] });
  }

  private markDatesFixed(mediaKeys: ReadonlySet<string>, fixed: boolean): void {
    this.set({ dateFixes: this.snapshot.dateFixes.map((d) => (mediaKeys.has(d.finding.item.mediaKey) ? { ...d, fixed, selected: !fixed } : d)) });
  }

  /** Small images for the listed rows, a few at a time. A thumbnail that fails only leaves a blank. */
  private async loadDateThumbs(): Promise<void> {
    const { dateFixes, dateFixesShown } = this.snapshot;
    const pending = dateFixes.slice(0, dateFixesShown).filter((d) => d.thumbUrl === null);
    const next = pending[Symbol.iterator]();
    const worker = async () => {
      for (const d of next) {
        try {
          const blob = await this.#gateway.thumbnail(d.finding.item.baseUrl, ScanSession.DATE_THUMB_SIDE);
          const url = URL.createObjectURL(blob);
          this.set({ dateFixes: this.snapshot.dateFixes.map((x) => (x.finding.id === d.finding.id ? { ...x, thumbUrl: url } : x)) });
        } catch (err) {
          console.error("[pixlixir] could not load a thumbnail", err);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  private static noDateFixes(): Pick<ScanSnapshot, "dateFixes" | "dateFixesShown" | "dateFixError" | "undoableDateFix"> {
    return { dateFixes: [], dateFixesShown: ScanSession.DATE_ROWS_PER_PAGE, dateFixError: null, undoableDateFix: false };
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
    for (const d of this.snapshot.dateFixes) if (d.thumbUrl) URL.revokeObjectURL(d.thumbUrl);
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
