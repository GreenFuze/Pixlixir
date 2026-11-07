/**
 * Library scan page controller (UI-framework independent).
 *
 * Started with a plan from the side panel or the launcher: scan (list items once, run the chosen
 * detectors; findings stream in) -> review (tick findings) -> bulk action -> results stay on
 * the page and in the side panel's recent work.
 */

import pLimit from "p-limit";
import type { LibraryItem } from "../../domain/types.js";
import { OriginalFinder, type LibraryLister, type OriginalMatch } from "../../scan/copy-originals.js";
import { DateFixApplier, FilenameDateDetector, type DateFixFinding, type PlannedDate } from "../../scan/date-fix.js";
import { DuplicateGrouper, DuplicatePlans, DuplicatesDetector, DuplicateSimilarity, DuplicateTrasher, type DuplicateGroup, type DuplicateIndex, type DuplicateMember, type PhotoPrint } from "../../scan/duplicates.js";
import { FilenameFormats } from "../../scan/filename-format.js";
import { LibraryCatalog } from "../../scan/library-catalog.js";
import { LibraryScanner, type ScanSummary } from "../../scan/library-scanner.js";
import { PanoramaDetector, ScanConcurrency, type AlreadyMade, type PanoramaCandidate, type SavedSequence } from "../../scan/panorama-detector.js";
import { ScanEta } from "../../scan/scan-eta.js";
import type { DetectorId, ScanContext, ScanDetector } from "../../scan/scan-detector.js";
import type { ScanPlan } from "../../scan/scan-plan.js";
import { ScanScopes } from "../../scan/scan-scope.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { CanvasCodec } from "../editor/canvas-codec.js";
import { EditorSession } from "../editor/editor-session.js";
import { PanoramaWorkerClient } from "../editor/panorama/panorama-client.js";
import { PanoramaSession } from "../editor/panorama/panorama-session.js";
import { PhotosGateway } from "../editor/photos-gateway.js";
import { FormatStore } from "../storage/format-store.js";
import { JobStore, type DateFixJob, type DuplicateTrashJob, type PanoramaJob } from "../storage/job-store.js";
import { ScanStore } from "../storage/scan-store.js";
import { SCAN_SELECTION_PREFIX, type ScanHandover } from "../tools.js";

import { PanoramaOriginals } from "../editor/panorama/panorama-originals.js";
import { CanvasPhotoPrinter } from "./canvas-photo-printer.js";
import { PanoramaBulkCreator } from "./panorama-bulk-creator.js";
import { EngineOverlapChecker } from "./engine-overlap-checker.js";

export interface ScanParams {
  tabId: number;
  email: string;
  /** One-time chrome.storage.session id set by the service worker; holds the plan. */
  planId: string;
}

export type CandidateStatus = "found" | "queued" | "working" | "created" | "failed";

export interface CandidateView {
  candidate: PanoramaCandidate;
  previewUrl: string;
  selected: boolean;
  status: CandidateStatus;
  step: string | null;
  result: { job: PanoramaJob; webUrl: string; width: number; height: number; albums: string[]; problems: string[]; skipped: number; warnings: string[] } | null;
  error: SerializedError | null;
}

export interface DateFixView {
  finding: DateFixFinding;
  /** The name holds the day it was saved, so it is never offered as the date taken. */
  copy: boolean;
  /** The larger photo this copy can take its date from, once searched for. */
  original: { item: LibraryItem; similarity: number; thumbUrl: string | null } | null;
  /** The search looked for this copy's original. */
  searched: boolean;
  selected: boolean;
  fixed: boolean;
  thumbUrl: string | null;
}

/** The duplicates results: one index, grouped live at the chosen similarity. */
export interface DuplicatesView {
  index: DuplicateIndex;
  similarity: number;
  choices: Record<string, "keep" | "trash">;
  /** Dedup keys of copies already in the trash. */
  gone: string[];
  /** How many groups are listed (the rest behind "Show more"). */
  shown: number;
  thumbs: Record<string, string>;
  error: SerializedError | null;
  /** Groups left alone in the last run. */
  skippedShared: number;
  problems: SerializedError[];
}

export type ScanPhase =
  | { name: "scanning"; step: string; done: number | null; total: number | null; secondsLeft: number | null }
  | { name: "review" }
  | { name: "creating"; done: number; total: number }
  | { name: "fixingDates"; done: number; total: number }
  | { name: "findingOriginals"; step: string; done: number | null; total: number | null; secondsLeft: number | null }
  | { name: "trashing"; done: number; total: number }
  | { name: "failed"; error: SerializedError };

export interface ScanSnapshot {
  params: ScanParams;
  phase: ScanPhase;
  /** What this scan looks for. */
  detectors: Record<DetectorId, boolean>;
  /** The result tab on show: the first to find something, until the user picks one. */
  tab: DetectorId | null;
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
  duplicates: DuplicatesView | null;
  /** A run that can be undone. */
  undoableDateFix: boolean;
  /** One group open in the Create-panorama editor, inside this modal. */
  editor: { candidateId: string; session: PanoramaSession } | null;
  /** How long the last scan took, once it has ended. */
  elapsedSeconds: number | null;
}

/** What a date row means, for its help and for what it can do. */
export class DateFixRow {
  /** Google stores whole seconds. */
  private static readonly SAME_MS = 1000;

  static sameDate(a: Pick<LibraryItem, "takenAtMs">, b: Pick<LibraryItem, "takenAtMs">): boolean {
    return Math.abs(a.takenAtMs - b.takenAtMs) < DateFixRow.SAME_MS;
  }

  /** An original with the same date has nothing to give. */
  static canTakeOriginal(d: Pick<DateFixView, "finding" | "original">): boolean {
    return d.original !== null && !DateFixRow.sameDate(d.finding.item, d.original.item);
  }

  /** The row's (?): what was found, and why the row looks as it does. */
  static help(d: Pick<DateFixView, "finding" | "copy" | "original" | "searched">, format: (ms: number, offsetMs: number) => string): string {
    const { item, fileTakenLocalMs, copyReason, fileAgrees, fileName, newTakenAtMs, mask } = d.finding;
    const lines: string[] = [];
    const shown = format(item.takenAtMs, item.timezoneOffsetMs);
    const inFile = fileTakenLocalMs === null ? null : format(fileTakenLocalMs, 0);

    // Paragraph: a wrong date: what the name asks for, and how far the file backs it.
    if (!d.copy) {
      lines.push(`Google Photos says ${shown}, but the name ${fileName} says ${format(newTakenAtMs, item.timezoneOffsetMs)} (format ${mask}).`);
      lines.push(fileAgrees && inFile ? `The file's own date, ${inFile}, agrees with the name, so the name is trusted.` : inFile ? `The file's own date is ${inFile}.` : "The file has no date of its own, so only the name says when it was taken.");
      lines.push("Fix writes the name's date.");
      return lines.join("\n");
    }

    // Paragraph: a saved copy: why the name is not trusted, and whether today's date already looks right.
    lines.push(copyReason === "file" ? `The name holds the day this copy was saved, not taken: the file's own date is ${inFile ?? "another day"}.`
      : copyReason === "group" ? "The name holds the day this copy was saved, not taken: many files share this name's day, while their dates are far apart."
      : copyReason === "name" ? "The name holds the day this copy was saved, not taken: it is only a date, with a copy counter or at a size made for sharing."
      : "You can treat this name as the date taken with Use name.");
    if (inFile !== null && fileTakenLocalMs !== null && Math.abs(fileTakenLocalMs - (item.takenAtMs + item.timezoneOffsetMs)) < 60_000) {
      lines.push(`Google Photos already shows the file's own date, ${shown}. That may be right, or the day a program stamped on it.`);
    } else {
      lines.push(`Google Photos says ${shown}.`);
    }

    // Paragraph: what the search for its original found.
    if (d.original) {
      const taken = format(d.original.item.takenAtMs, d.original.item.timezoneOffsetMs);
      lines.push(DateFixRow.sameDate(item, d.original.item) ? `Its likely original has the same date, so there is nothing to fix.` : `Its likely original was taken ${taken}, ${d.original.similarity}% alike. Fix writes that date and time zone.`);
    } else {
      lines.push(d.searched ? "No larger photo of this picture was found, so nothing is changed." : "Not searched for its original yet.");
    }
    return lines.join("\n");
  }
}

export class ScanSession extends EditorSession<ScanSnapshot> {
  static readonly THUMB_SIDE = 160;
  static readonly DATE_ROWS_PER_PAGE = 100;
  static readonly DATE_THUMB_SIDE = 96;
  static readonly DUPLICATE_GROUPS_PER_PAGE = 50;

  readonly #gateway: PhotosGateway;
  readonly #worker: PanoramaWorkerClient;
  #store: JobStore | null = null;
  #results: ScanStore | null = null;
  #scan: AbortController | null = null;
  #stopCreating = false;
  #nextKey = 1;
  #lastActivity: string | null = null;
  #dateJob: DateFixJob | null = null;
  #plan: ScanPlan | null = null;
  /** Engines that only live while a scan runs: each holds a whole Python runtime in memory. */
  #scanEngines: PanoramaWorkerClient[] = [];
  #duplicateGroups: { index: DuplicateIndex; similarity: number; gone: string[]; groups: DuplicateGroup[] } | null = null;

  constructor(params: ScanParams) {
    super({
      params,
      phase: { name: "scanning", step: "Starting", done: null, total: null, secondsLeft: null },
      detectors: { panorama: false, dates: false, duplicates: false },
      tab: null,
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
      duplicates: null,
      undoableDateFix: false,
      editor: null,
      elapsedSeconds: null,
    });
    this.#gateway = new PhotosGateway(params.email, params.tabId);
    this.#worker = new PanoramaWorkerClient((stage) => this.set({ progress: stage }));
  }

  static paramsFromUrl(search: string): ScanParams {
    const q = new URLSearchParams(search);
    const tabId = Number(q.get("tab"));
    const email = q.get("email") ?? "";
    const planId = q.get("sel");
    if (!Number.isInteger(tabId) || !email.includes("@") || !planId) {
      throw new PixError(ErrorCode.InvalidMessage, "Start the scan from the Pixlixir menu in Google Photos.", { tabId, hasEmail: email.length > 0, hasSession: planId !== null });
    }
    return { tabId, email, planId };
  }

  dispose(): void {
    this.#scan?.abort();
    this.snapshot.editor?.session.dispose();
    this.disposeScanEngines();
    this.#worker.dispose();
    this.#store?.close();
    this.#results?.close();
    this.revokeAll();
  }

  // ---- start -------------------------------------------------------------------

  async init(): Promise<void> {
    try {
      // Paragraph: this page may only run when opened through the service worker (one-time id).
      this.#store = await JobStore.open();
      this.#results = await ScanStore.open();
      const k = SCAN_SELECTION_PREFIX + this.snapshot.params.planId;
      const handover = (await chrome.storage.session.get(k))[k] as ScanHandover | undefined;
      if (!handover || handover.accountEmail !== this.snapshot.params.email) throw new PixError(ErrorCode.InvalidMessage, "Start the scan from the Pixlixir menu in Google Photos.");
      await chrome.storage.session.remove(k);
      this.#plan = handover.plan;
      this.set({ detectors: handover.plan.detectors });
    } catch (err) {
      this.fail(err);
      this.reportActivity(null);
      return;
    }
    await this.startScan();
  }

  /** The same plan again. Saved results now count: "Re-check all" applies to the first run only. */
  scanAgain(): void {
    if (this.#plan) this.#plan = { ...this.#plan, recheck: false };
    void this.startScan();
  }

  private plan(): ScanPlan {
    if (!this.#plan) throw new PixError(ErrorCode.Internal, "The scan has no plan");
    return this.#plan;
  }

  // ---- scanning ----------------------------------------------------------------

  async startScan(): Promise<void> {
    // Paragraph: fresh state, chosen detectors.
    this.revokeAll();
    this.set({ candidates: [], thumbs: {}, summary: null, scanError: null, tab: null, duplicates: null, elapsedSeconds: null, ...ScanSession.noDateFixes() });
    this.#dateJob = null;
    const ctrl = new AbortController();
    this.#scan = ctrl;
    const started = Date.now();
    const ended = () => ({ phase: { name: "review" as const }, progress: null, elapsedSeconds: (Date.now() - started) / 1000 });
    try {
      const scope = ScanScopes.validate(this.plan().scope);
      this.set({ scopeLabel: ScanScopes.describe(scope) });
      const detectors = await this.chosenDetectors();
      if (detectors.length === 0) throw new PixError(ErrorCode.InvalidMessage, "Choose at least one thing to look for.");

      // Paragraph: run; findings appear as they are found.
      this.set({ phase: { name: "scanning", step: "Starting", done: null, total: null, secondsLeft: null } });
      const scanner = new LibraryScanner(new LibraryCatalog(this.#gateway), detectors);
      const progress = this.timedProgress("scanning", "Scanning");
      const summary = await scanner.run(scope, { signal: ctrl.signal, progress }, (finding) => {
        if (finding.detector === "dates") this.addDateFix(finding as DateFixFinding);
        else if (finding.detector === "duplicates") this.setDuplicates(finding as DuplicateIndex);
        else this.addCandidate(finding as PanoramaCandidate);
      });
      this.set({ summary, progress: null });
      void this.loadDateThumbs();

      // Paragraph: saved copies are only useful with their originals, so looking for them is part of the scan.
      this.disposeScanEngines();
      await this.searchOriginals(ctrl.signal, progress, scope.kind === "library" ? scanner.listed : null);
      this.set(ended());
      this.reportActivity("Scan results");
    } catch (err) {
      // A stopped scan keeps what it found so far.
      const e = EditorSession.toError(err, "The scan failed");
      this.set({ ...ended(), scanError: e.code === ErrorCode.Cancelled ? null : e.toJSON() });
      this.reportActivity("Scan results");
    } finally {
      this.disposeScanEngines();
      this.#scan = null;
    }
  }

  /** Progress with time left, restarting the estimate at each new step. */
  private timedProgress(name: "scanning" | "findingOriginals", activity: string): (step: string, done?: number, total?: number) => void {
    let eta = new ScanEta();
    let etaStep = "";
    return (step, done, total) => {
      const counted = done !== undefined && total !== undefined;
      if (step !== etaStep) {
        eta = new ScanEta();
        etaStep = step;
      }
      this.set({ phase: { name, step, done: done ?? null, total: total ?? null, secondsLeft: counted ? eta.update(done, total, Date.now()) : null } });
      this.reportActivity(counted && total > 0 ? `${activity} ${Math.floor((done / total) * 100)}%` : `${activity}…`);
    };
  }

  private disposeScanEngines(): void {
    for (const engine of this.#scanEngines) engine.dispose();
    this.#scanEngines = [];
  }

  stopScan(): void {
    this.#scan?.abort();
  }

  chooseTab(tab: DetectorId): void {
    this.set({ tab });
  }

  private isRunning(): boolean {
    const { name } = this.snapshot.phase;
    return name === "scanning" || name === "creating" || name === "fixingDates" || name === "findingOriginals" || name === "trashing";
  }

  /** Cheap checks first, so their findings appear before the stitching engine starts. */
  private async chosenDetectors(): Promise<ScanDetector[]> {
    const { params } = this.snapshot;
    const { detectors: chosen, recheck } = this.plan();
    const detectors: ScanDetector[] = [];
    if (chosen.dates) {
      const formats = new FilenameFormats(await new FormatStore(params.email).load());
      detectors.push(new FilenameDateDetector(this.#gateway, formats, this.results().cache<string>(params.email, "dates"), this.#gateway) as ScanDetector);
    }
    if (chosen.duplicates) {
      const prints = this.results().cache<PhotoPrint>(params.email, "duplicates");
      const details = this.results().cache<Uint8Array>(params.email, "duplicates");
      detectors.push(new DuplicatesDetector(new CanvasPhotoPrinter(this.#gateway), this.#gateway, prints, details, recheck) as ScanDetector);
    }
    if (chosen.panorama) {
      const saved = await this.store().savedPanoramas(params.email);
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      const downloads = pLimit(EngineOverlapChecker.PARALLEL_DOWNLOADS);
      this.#scanEngines = Array.from({ length: ScanConcurrency.engines(navigator.hardwareConcurrency, memory) }, () => new PanoramaWorkerClient(() => {}));
      const checkers = this.#scanEngines.map((engine) => new EngineOverlapChecker(this.#gateway, engine, downloads, () => this.#nextKey++, (blob) => CanvasCodec.thumbnail(blob, ScanSession.THUMB_SIDE)));
      const cache = this.results().cache<SavedSequence>(params.email, "panorama");
      detectors.push(new PanoramaDetector(checkers, (items) => ScanSession.alreadyMade(saved, items), cache, recheck) as ScanDetector);
    }
    return detectors;
  }

  // ---- the modal -------------------------------------------------------------------

  /** Keeps working in the background; the chip on the Photos tab shows progress and brings it back. */
  minimize(): void {
    this.set({ confirmingClose: false });
    void this.#gateway.minimizeModal().catch((e: unknown) => this.set({ scanError: EditorSession.failure(e) }));
  }

  /** Closes right away unless work is running, which needs a confirmation first. */
  requestClose(): void {
    if (this.isRunning()) this.set({ confirmingClose: true });
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

  /**
   * Status on the chip and in the panel. Busy work is never replaced by a new scan: anything
   * running, and a date run that can still be undone, since closing it loses the Undo.
   */
  private reportActivity(label: string | null): void {
    const activity = label === null ? null : { label, busy: this.isRunning() || this.snapshot.undoableDateFix };
    const key = JSON.stringify(activity);
    if (key === this.#lastActivity) return;
    this.#lastActivity = key;
    this.#gateway.reportActivity(activity).catch((e: unknown) => console.error("[pixlixir] could not update the chip", e));
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
        result: { job: editor.session.snapshot.job!, webUrl, width, height, albums: published.albumsAdded.map((a) => a.title), problems: published.problems.map((p) => p.message), skipped: 0, warnings: [] },
      }));
    }
    editor.session.dispose();
    this.set({ editor: null });
  }

  // ---- wrong dates ---------------------------------------------------------------------

  toggleDateFix(mediaKey: string): void {
    this.set({ dateFixes: this.snapshot.dateFixes.map((d) => (d.finding.item.mediaKey === mediaKey && !d.fixed ? { ...d, selected: !d.selected } : d)) });
  }

  selectAllDateFixes(selected: boolean): void {
    this.set({ dateFixes: this.snapshot.dateFixes.map((d) => (d.fixed || (d.copy && !DateFixRow.canTakeOriginal(d)) ? d : { ...d, selected })) });
  }

  selectedDateFixes(): number {
    return this.snapshot.dateFixes.filter((d) => d.selected && !d.fixed).length;
  }

  /** The user says this name really is the date taken. */
  treatAsWrongDate(mediaKey: string): void {
    this.set({ dateFixes: this.snapshot.dateFixes.map((d) => (d.finding.item.mediaKey === mediaKey ? { ...d, copy: false, original: null, selected: true } : d)) });
  }

  /** Continues a search that was stopped or failed. */
  async findOriginals(): Promise<void> {
    const ctrl = new AbortController();
    this.#scan = ctrl;
    this.set({ phase: { name: "findingOriginals", step: "Listing the library", done: null, total: null, secondsLeft: null } });
    try {
      await this.searchOriginals(ctrl.signal, this.timedProgress("findingOriginals", "Finding originals"), null);
    } finally {
      this.#scan = null;
      this.set({ phase: { name: "review" } });
      this.reportActivity("Scan results");
    }
  }

  /**
   * Looks through the library for the larger photo each saved copy came from. Prints are shared with
   * Duplicates, and saved as it goes. Being stopped or failing costs this search, never the scan's results.
   */
  private async searchOriginals(signal: AbortSignal, progress: ScanContext["progress"], library: readonly LibraryItem[] | null): Promise<void> {
    const copies = this.snapshot.dateFixes.filter((d) => d.copy && !d.fixed).map((d) => d.finding.item);
    if (copies.length === 0) return;
    this.set({ dateFixError: null });
    try {
      const { email } = this.snapshot.params;
      const lister: LibraryLister = library ? { collect: async () => [...library] } : new LibraryCatalog(this.#gateway);
      const finder = new OriginalFinder(new CanvasPhotoPrinter(this.#gateway), this.results().cache<PhotoPrint>(email, "duplicates"), this.results().cache<Uint8Array>(email, "duplicates"), lister);
      const { unreadable } = await finder.run(copies, { signal, progress }, (match) => this.addOriginal(match));
      const looked = new Set(copies.map((c) => c.mediaKey));
      this.set({ dateFixes: this.snapshot.dateFixes.map((d) => (looked.has(d.finding.item.mediaKey) ? { ...d, searched: true } : d)) });
      if (unreadable > 0) this.set({ dateFixError: new PixError(ErrorCode.MediaFetchFailed, `${unreadable.toLocaleString()} photo${unreadable === 1 ? "" : "s"} could not be read, so an original may have been missed`, { unreadable }).toJSON() });
    } catch (err) {
      const e = EditorSession.toError(err, "Could not look for the originals");
      if (e.code !== ErrorCode.Cancelled) this.set({ dateFixError: e.toJSON() });
    }
  }

  /** A pair the same at any size is ticked; a looser one waits for the user to look. */
  private addOriginal(match: OriginalMatch): void {
    const key = match.copy.mediaKey;
    const sameDate = DateFixRow.sameDate(match.copy, match.original);
    this.set({ dateFixes: this.snapshot.dateFixes.map((d) => (d.finding.item.mediaKey === key ? { ...d, original: { item: match.original, similarity: match.similarity, thumbUrl: null }, selected: match.similarity === 100 && !sameDate } : d)) });
    void this.#gateway.thumbnail(match.original.baseUrl, ScanSession.DATE_THUMB_SIDE).then((blob) => {
      const url = URL.createObjectURL(blob);
      this.set({ dateFixes: this.snapshot.dateFixes.map((d) => (d.finding.item.mediaKey === key && d.original ? { ...d, original: { ...d.original, thumbUrl: url } } : d)) });
    }, (err: unknown) => console.error("[pixlixir] no thumbnail for an original", err));
  }

  /** What a row would write: its name's date, or for a copy its original's date and time zone. */
  private static dateTarget(d: DateFixView): { takenAtMs: number; timezoneOffsetMs: number } {
    return d.original ? { takenAtMs: d.original.item.takenAtMs, timezoneOffsetMs: d.original.item.timezoneOffsetMs } : { takenAtMs: d.finding.newTakenAtMs, timezoneOffsetMs: d.finding.item.timezoneOffsetMs };
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
      changes: views.map((d) => {
        const f = d.finding, target = ScanSession.dateTarget(d);
        return { mediaKey: f.item.mediaKey, dedupKey: f.item.dedupKey, fileName: f.fileName, oldTakenAtMs: f.item.takenAtMs, newTakenAtMs: target.takenAtMs, timezoneOffsetMs: target.timezoneOffsetMs, oldTimezoneOffsetMs: f.item.timezoneOffsetMs, applied: false };
      }),
    });
    this.#dateJob = job;

    // Paragraph: write and read back, batch by batch.
    const planned: PlannedDate[] = job.changes.map((c) => ({ mediaKey: c.mediaKey, fileName: c.fileName, dedupKey: c.dedupKey, takenAtMs: c.newTakenAtMs, timezoneOffsetMs: c.timezoneOffsetMs }));
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
    const planned: PlannedDate[] = done.map((c) => ({ mediaKey: c.mediaKey, fileName: c.fileName, dedupKey: c.dedupKey, takenAtMs: c.oldTakenAtMs, timezoneOffsetMs: c.oldTimezoneOffsetMs ?? c.timezoneOffsetMs }));
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
      this.set({ phase: { name: "review" }, undoableDateFix: false });
      this.reportActivity("Scan results");
      return;
    } catch (err) {
      // Paragraph: what is still changed stays undoable.
      const e = EditorSession.toError(err, "Could not put the dates back");
      this.#dateJob = await this.store().put<DateFixJob>({ ...original, status: "partial", error: e.toJSON(), changes: original.changes.map((c) => (restored.has(c.mediaKey) ? { ...c, applied: false } : c)) });
      this.set({ dateFixError: e.toJSON() });
    }
    this.set({ phase: { name: "review" } });
  }

  private addDateFix(finding: DateFixFinding): void {
    this.set({ dateFixes: [...this.snapshot.dateFixes, { finding, copy: finding.exportDate, original: null, searched: false, selected: !finding.exportDate, fixed: false, thumbUrl: null }], tab: this.snapshot.tab ?? "dates" });
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
          result: { job: r.job, webUrl: r.job.saved!.webUrl, width: r.width, height: r.height, albums: r.published.albumsAdded.map((a) => a.title), problems: r.published.problems.map((p) => p.message), skipped: r.skipped.length, warnings: r.warnings },
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

  // ---- duplicates ----------------------------------------------------------------------

  private setDuplicates(index: DuplicateIndex): void {
    if (index.links.length === 0) return;
    this.set({
      duplicates: { index, similarity: DuplicateSimilarity.DEFAULT_PERCENT, choices: {}, gone: [], shown: ScanSession.DUPLICATE_GROUPS_PER_PAGE, thumbs: {}, error: null, skippedShared: 0, problems: [] },
      tab: this.snapshot.tab ?? "duplicates",
    });
    void this.loadDuplicateThumbs();
  }

  /** The groups at the current similarity (grouped once per change). */
  duplicateGroups(): DuplicateGroup[] {
    const view = this.snapshot.duplicates;
    if (!view) return [];
    const memo = this.#duplicateGroups;
    if (memo && memo.index === view.index && memo.similarity === view.similarity && memo.gone === view.gone) return memo.groups;
    const groups = DuplicateGrouper.groups(view.index, view.similarity, new Set(view.gone));
    this.#duplicateGroups = { index: view.index, similarity: view.similarity, gone: view.gone, groups };
    return groups;
  }

  setDuplicateSimilarity(similarity: number): void {
    const view = this.snapshot.duplicates;
    if (!view) return;
    this.set({ duplicates: { ...view, similarity, shown: ScanSession.DUPLICATE_GROUPS_PER_PAGE } });
    void this.loadDuplicateThumbs();
  }

  showMoreDuplicates(): void {
    const view = this.snapshot.duplicates;
    if (!view) return;
    this.set({ duplicates: { ...view, shown: view.shown + ScanSession.DUPLICATE_GROUPS_PER_PAGE } });
    void this.loadDuplicateThumbs();
  }

  /** Flips one photo, unless that would leave its group with nothing to keep. */
  toggleDuplicate(group: DuplicateGroup, member: DuplicateMember): void {
    const view = this.snapshot.duplicates;
    if (!view || member.photo.item.editable === false) return;
    const choices = { ...view.choices, [member.photo.item.dedupKey]: DuplicatePlans.goes(group, member, view.choices) ? "keep" as const : "trash" as const };
    if (group.members.every((m) => DuplicatePlans.goes(group, m, choices))) return;
    this.set({ duplicates: { ...view, choices } });
  }

  /** All: back to the automatic choice. None: nothing goes. */
  chooseAllDuplicates(trash: boolean): void {
    const view = this.snapshot.duplicates;
    if (!view) return;
    const choices: Record<string, "keep"> = {};
    if (!trash) for (const g of this.duplicateGroups()) for (const m of g.members) choices[m.photo.item.dedupKey] = "keep";
    this.set({ duplicates: { ...view, choices } });
  }

  duplicatesToTrash(): number {
    const view = this.snapshot.duplicates;
    if (!view) return 0;
    return this.duplicateGroups().reduce((n, g) => n + (DuplicatePlans.plan(g, view.choices)?.trash.length ?? 0), 0);
  }

  /** Moves the ticked copies to trash, after the user confirmed. */
  async trashDuplicates(): Promise<void> {
    const view = this.snapshot.duplicates;
    if (!view) return;
    const plans = this.duplicateGroups().flatMap((g) => DuplicatePlans.plan(g, view.choices) ?? []);
    const dedupKeys = plans.flatMap((p) => p.trash.map((i) => i.dedupKey));
    if (dedupKeys.length === 0) return;

    // Paragraph: the record comes before the first move.
    const now = Date.now();
    let job = await this.store().put<DuplicateTrashJob>({ id: crypto.randomUUID(), kind: "duplicateTrash", accountEmail: this.snapshot.params.email, sourceMediaKey: plans[0]!.trash[0]!.mediaKey, dedupKeys, moved: [], status: "saving", error: null, createdAt: now, updatedAt: now });
    const patch = (p: Partial<DuplicatesView>) => this.set({ duplicates: { ...this.snapshot.duplicates!, ...p } });
    patch({ error: null, skippedShared: 0, problems: [] });
    this.set({ phase: { name: "trashing", done: 0, total: dedupKeys.length } });
    this.reportActivity("Moving to trash");

    // Paragraph: what reached the trash leaves the list at once, even if a later batch fails.
    try {
      const r = await new DuplicateTrasher(this.#gateway).run(plans, (done, total) => this.set({ progress: `Preparing group ${done + 1} of ${total}` }), async (keys) => {
        job = await this.store().put<DuplicateTrashJob>({ ...job, moved: [...job.moved, ...keys] });
        patch({ gone: [...this.snapshot.duplicates!.gone, ...keys] });
        this.set({ progress: null, phase: { name: "trashing", done: job.moved.length, total: dedupKeys.length } });
      });
      patch({ skippedShared: r.skippedShared, problems: r.problems });
      await this.store().put<DuplicateTrashJob>({ ...job, status: job.moved.length === dedupKeys.length ? "done" : "partial" });
    } catch (err) {
      const e = EditorSession.toError(err, "Could not move the photos to trash");
      await this.store().put<DuplicateTrashJob>({ ...job, status: job.moved.length > 0 ? "partial" : "failed", error: e.toJSON() });
      patch({ error: e.toJSON() });
    }
    this.set({ phase: { name: "review" }, progress: null });
    this.reportActivity("Scan results");
  }

  /** Small images for the listed groups, a few at a time. A thumbnail that fails only leaves a blank. */
  private async loadDuplicateThumbs(): Promise<void> {
    const view = this.snapshot.duplicates;
    if (!view) return;
    const pending = this.duplicateGroups().slice(0, view.shown).flatMap((g) => g.members.map((m) => m.photo.item)).filter((i) => !view.thumbs[i.dedupKey]);
    const next = pending[Symbol.iterator]();
    const worker = async () => {
      for (const item of next) {
        try {
          const blob = await this.#gateway.thumbnail(item.baseUrl, CanvasPhotoPrinter.READ_SIDE * 2);
          const current = this.snapshot.duplicates;
          if (current?.index === view.index) this.set({ duplicates: { ...current, thumbs: { ...current.thumbs, [item.dedupKey]: URL.createObjectURL(blob) } } });
        } catch (err) {
          console.error("[pixlixir] could not load a thumbnail", err);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  // ---- originals of created panoramas --------------------------------------------------

  /** Created panoramas whose photos are still in the library. */
  withOriginals(): CandidateView[] {
    return this.snapshot.candidates.filter((c) => c.result && ScanSession.trashableKeys(c).length > 0);
  }

  /** Only photos that are in the panorama, belong to this account and are not in the trash yet. */
  static trashableKeys(view: Pick<CandidateView, "candidate" | "result">): string[] {
    const notOwned = new Set(view.candidate.items.filter((i) => i.editable === false).map((i) => i.dedupKey));
    const moved = new Set(view.result?.job.originalsTrash?.moved ?? []);
    return (view.result?.job.usedDedupKeys ?? []).filter((k) => !notOwned.has(k) && !moved.has(k));
  }

  /** Moves the originals of these panoramas to trash, after the user confirmed. One failure stops the run. */
  async trashOriginals(ids: readonly string[]): Promise<void> {
    const views = ids.map((id) => this.view(id));
    const total = views.reduce((n, v) => n + ScanSession.trashableKeys(v).length, 0);
    if (total === 0) return;
    const originals = new PanoramaOriginals(this.#gateway, this.store());
    let done = 0;
    this.set({ phase: { name: "trashing", done, total } });
    this.reportActivity("Moving to trash");

    // Paragraph: one panorama at a time, each confirmed in the library first.
    for (const view of views) {
      const id = view.candidate.id;
      const before = done;
      const already = view.result!.job.originalsTrash?.moved.length ?? 0;
      const r = await originals.trash(view.result!.job, ScanSession.trashableKeys(view), (moved) => {
        this.set({ phase: { name: "trashing", done: before + moved - already, total } });
      });
      done += (r.job.originalsTrash?.moved.length ?? already) - already;
      this.patchCandidate(id, (c) => ({ result: { ...c.result!, job: r.job }, error: r.error?.toJSON() ?? null }));
      if (r.error) break;
    }
    this.set({ phase: { name: "review" } });
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
    // Engines finish in any order; the list stays in capture order.
    const candidates = [...this.snapshot.candidates, view].sort((a, b) => a.candidate.items[0]!.takenAtMs - b.candidate.items[0]!.takenAtMs);
    this.set({ candidates, thumbs, tab: this.snapshot.tab ?? "panorama" });
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
    for (const d of this.snapshot.dateFixes) for (const url of [d.thumbUrl, d.original?.thumbUrl]) if (url) URL.revokeObjectURL(url);
    for (const url of Object.values(this.snapshot.duplicates?.thumbs ?? {})) URL.revokeObjectURL(url);
  }

  /**
   * A saved panorama counts as "already made" when it used at least half of these photos, and covers
   * them when it used more. Compared by dedup key (album listings use album-specific media keys);
   * jobs saved before dedup keys were recorded are compared by media key.
   */
  static alreadyMade(saved: readonly PanoramaJob[], items: readonly LibraryItem[]): AlreadyMade | null {
    for (const job of saved) {
      if (!job.saved) continue;
      const byDedup = job.usedDedupKeys !== undefined && job.usedDedupKeys.length > 0;
      const used = new Set(byDedup ? job.usedDedupKeys : job.usedMediaKeys.length > 0 ? job.usedMediaKeys : job.sourceMediaKeys);
      const shared = items.filter((i) => used.has(byDedup ? i.dedupKey : i.mediaKey)).length;
      if (shared * 2 >= items.length) return { webUrl: job.saved.webUrl, covers: shared * 2 > items.length };
    }
    return null;
  }
}
