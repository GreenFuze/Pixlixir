/**
 * Panorama editor controller (UI-framework independent).
 *
 * Owns: the selected source photos (downloaded originals, decoded into the worker),
 * stitch settings, the live preview, the job record and the save pipeline.
 * The original photos are never modified; the panorama is saved as a new item that
 * inherits the photos' date, location, description and albums (panorama-pipeline.ts).
 */

import type { MediaItemInfo } from "../../../domain/types.js";
import { DEFAULT_STITCH_SETTINGS, type StitchSettings } from "../../../imaging/panorama/stitch-runtime.js";
import { ErrorCode, PixError, type SerializedError } from "../../../shared/errors.js";
import { JobStore, type PanoramaJob } from "../../storage/job-store.js";
import { TOOLS } from "../../tools.js";
import { CanvasCodec } from "../canvas-codec.js";
import { EditorSession, type EditorParams } from "../editor-session.js";
import { PhotosGateway } from "../photos-gateway.js";
import { PanoramaWorkerClient } from "./panorama-client.js";
import { MetadataInheritance, PanoramaPublisher, PanoramaSourceLoader, type InheritedMetadata, type PublishChoices, type PublishedPanorama } from "./panorama-pipeline.js";
import type { PanoramaRender } from "./panorama-worker.js";

export type PanoramaQuality = "max" | "large" | "medium";

export interface PanoramaSource {
  /** Small integer id used by the worker. */
  key: number;
  mediaKey: string;
  item: MediaItemInfo | null;
  thumbUrl: string | null;
  status: "waiting" | "downloading" | "ready" | "failed";
  error: SerializedError | null;
  included: boolean;
  /** Pixel size given to the engine, and whether it was reduced to fit in memory. */
  size: { width: number; height: number } | null;
  downscaled: boolean;
}

export interface PanoramaPreview {
  url: string;
  fillUrl: string | null;
  width: number;
  height: number;
  used: number[];
  dropped: number[];
  filledFraction: number;
  scaleToFull: number;
  seconds: number;
}

export type PanoramaPhase =
  | { name: "loading"; step: string }
  | { name: "ready" }
  | { name: "saving"; step: string }
  | { name: "saved" }
  | { name: "failed"; error: SerializedError };

/** What the save dialog shows: the metadata the panorama will inherit. */
export type SaveDraft = { status: "loading" } | { status: "ready"; inherited: InheritedMetadata } | { status: "failed"; error: SerializedError };

export interface PanoramaSnapshot {
  params: EditorParams;
  phase: PanoramaPhase;
  sources: PanoramaSource[];
  settings: StitchSettings;
  quality: PanoramaQuality;
  preview: PanoramaPreview | null;
  previewBusy: boolean;
  previewError: SerializedError | null;
  /** Latest engine stage (e.g. "Matching photos"). */
  progress: string | null;
  job: PanoramaJob | null;
  saveDraft: SaveDraft | null;
  published: PublishedPanorama | null;
}

export class PanoramaSession extends EditorSession<PanoramaSnapshot> {
  static readonly MIN_PHOTOS = TOOLS.panorama.minPhotos;
  static readonly MAX_PHOTOS = TOOLS.panorama.maxPhotos;
  /** Output caps (megapixels of the whole panorama), sized to stay inside a browser tab's memory. */
  static readonly QUALITY_MEGAPIXELS: Record<PanoramaQuality, number> = { max: 60, large: 25, medium: 10 };

  readonly #worker: PanoramaWorkerClient;
  readonly #gateway: PhotosGateway;
  readonly #loader: PanoramaSourceLoader;
  readonly #heads = new Map<number, Uint8Array>();
  #store: JobStore | null = null;
  #previewTimer: ReturnType<typeof setTimeout> | null = null;
  #previewGeneration = 0;
  #saved: { blob: Blob } | null = null;

  constructor(params: EditorParams) {
    super({
      params,
      phase: { name: "loading", step: "Connecting to Google Photos…" },
      sources: params.mediaKeys.map((mediaKey, i) => ({ key: i + 1, mediaKey, item: null, thumbUrl: null, status: "waiting", error: null, included: true, size: null, downscaled: false })),
      settings: { ...DEFAULT_STITCH_SETTINGS },
      quality: "max",
      preview: null,
      previewBusy: false,
      previewError: null,
      progress: null,
      job: null,
      saveDraft: null,
      published: null,
    });
    this.#worker = new PanoramaWorkerClient((stage) => this.set({ progress: stage }));
    this.#gateway = new PhotosGateway(params.email, params.tabId);
    this.#loader = new PanoramaSourceLoader(this.#gateway, this.#worker, (blob) => CanvasCodec.thumbnail(blob, 240));
  }

  static paramsFromUrl(search: string): EditorParams {
    return EditorSession.parseParams(search, { min: PanoramaSession.MIN_PHOTOS, max: PanoramaSession.MAX_PHOTOS });
  }

  dispose(): void {
    this.#worker.dispose();
    this.#store?.close();
    if (this.#previewTimer) clearTimeout(this.#previewTimer);
    for (const s of this.snapshot.sources) if (s.thumbUrl) URL.revokeObjectURL(s.thumbUrl);
    this.revokePreview(this.snapshot.preview);
  }

  // ---- loading ---------------------------------------------------------------

  async init(): Promise<void> {
    try {
      // Paragraph: storage, engine start-up (in parallel with downloads), job record.
      this.#store = await JobStore.open();
      const engine = this.#worker.start();
      const { params } = this.snapshot;
      const now = Date.now();
      this.set({
        job: await this.#store.put<PanoramaJob>({
          id: crypto.randomUUID(), kind: "panorama", accountEmail: params.email, sourceMediaKey: params.mediaKeys[0]!, sourceMediaKeys: params.mediaKeys,
          usedMediaKeys: [], settings: this.snapshot.settings, status: "editing", saved: null, error: null, batchId: null, inherited: null, createdAt: now, updatedAt: now,
        }),
      });

      // Paragraph: download and decode each original (one at a time to bound memory).
      const budget = PanoramaSourceLoader.budgetPerPhoto(params.mediaKeys.length);
      for (const [i, source] of this.snapshot.sources.entries()) {
        this.set({ phase: { name: "loading", step: `Downloading photo ${i + 1} of ${params.mediaKeys.length}…` } });
        await this.loadSource(source.key, budget);
      }
      await engine;

      // Paragraph: need at least two usable photos.
      const ready = this.snapshot.sources.filter((s) => s.status === "ready");
      if (ready.length < PanoramaSession.MIN_PHOTOS) {
        throw new PixError(ErrorCode.StitchNotConnected, "At least two of the selected photos must load to make a panorama.", { loaded: ready.length });
      }
      this.set({ phase: { name: "ready" } });
      this.schedulePreview(0);
    } catch (err) {
      this.fail(err);
    }
  }

  private async loadSource(key: number, budgetMegapixels: number): Promise<void> {
    const source = this.source(key);
    this.patchSource(key, { status: "downloading" });
    try {
      const loaded = await this.#loader.load(key, source.mediaKey, budgetMegapixels);
      this.#heads.set(key, loaded.head);
      this.patchSource(key, { item: loaded.item, thumbUrl: URL.createObjectURL(loaded.thumb), size: loaded.size, downscaled: loaded.downscaled, status: "ready", error: null });
    } catch (err) {
      const e = EditorSession.toError(err, "Could not load this photo");
      // Account/session problems affect every photo: stop the whole editor.
      if (e.code === ErrorCode.AccountMismatch || e.code === ErrorCode.TabNotBound || e.code === ErrorCode.SessionUnavailable) throw e;
      this.patchSource(key, { status: "failed", error: e.toJSON(), included: false });
    }
  }

  // ---- settings ----------------------------------------------------------------

  setSettings(patch: Partial<StitchSettings>): void {
    this.set({ settings: { ...this.snapshot.settings, ...patch } });
    this.schedulePreview(250);
  }

  setQuality(quality: PanoramaQuality): void {
    this.set({ quality });
  }

  toggleSource(key: number): void {
    const s = this.source(key);
    if (s.status !== "ready") return;
    this.patchSource(key, { included: !s.included });
    this.schedulePreview(250);
  }

  includedKeys(): number[] {
    return this.snapshot.sources.filter((s) => s.included && s.status === "ready").map((s) => s.key);
  }

  /** Size the saved panorama would have at the chosen quality (from the preview), or null. */
  estimatedOutput(): { width: number; height: number; capped: boolean } | null {
    const p = this.snapshot.preview;
    if (!p) return null;
    const full = { width: p.width * p.scaleToFull, height: p.height * p.scaleToFull };
    const cap = PanoramaSession.QUALITY_MEGAPIXELS[this.snapshot.quality];
    const area = (full.width * full.height) / 1e6;
    const shrink = area > cap ? Math.sqrt(cap / area) : 1;
    return { width: Math.round(full.width * shrink), height: Math.round(full.height * shrink), capped: shrink < 1 };
  }

  // ---- preview -------------------------------------------------------------------

  retryPreview(): void {
    this.schedulePreview(0);
  }

  private schedulePreview(delayMs: number): void {
    if (this.#previewTimer) clearTimeout(this.#previewTimer);
    this.#previewTimer = setTimeout(() => void this.renderPreview(), delayMs);
  }

  private async renderPreview(): Promise<void> {
    if (this.snapshot.phase.name !== "ready") return;
    const keys = this.includedKeys();
    const generation = ++this.#previewGeneration;
    if (keys.length < PanoramaSession.MIN_PHOTOS) {
      this.revokePreview(this.snapshot.preview);
      this.set({ preview: null, previewBusy: false, previewError: new PixError(ErrorCode.StitchNotConnected, "Include at least two photos.").toJSON() });
      return;
    }
    this.set({ previewBusy: true, previewError: null });
    try {
      const r = await this.#worker.stitch(keys, this.snapshot.settings, { kind: "preview" });
      if (generation !== this.#previewGeneration) return; // superseded by a newer request
      this.revokePreview(this.snapshot.preview);
      this.set({ preview: PanoramaSession.toPreview(r), previewBusy: false, progress: null });
    } catch (err) {
      if (generation !== this.#previewGeneration) return;
      this.revokePreview(this.snapshot.preview);
      this.set({ preview: null, previewBusy: false, progress: null, previewError: EditorSession.failure(err) });
    }
  }

  private static toPreview(r: PanoramaRender): PanoramaPreview {
    return {
      url: URL.createObjectURL(r.image),
      fillUrl: r.fillOverlay ? URL.createObjectURL(r.fillOverlay) : null,
      width: r.width, height: r.height, used: r.used, dropped: r.dropped, filledFraction: r.filledFraction, scaleToFull: r.scaleToFull, seconds: r.seconds,
    };
  }

  private revokePreview(p: PanoramaPreview | null): void {
    if (!p) return;
    URL.revokeObjectURL(p.url);
    if (p.fillUrl) URL.revokeObjectURL(p.fillUrl);
  }

  // ---- output ----------------------------------------------------------------------

  /** Opens the save dialog: reads what the panorama will inherit from the photos in it. */
  async prepareSave(): Promise<void> {
    this.set({ saveDraft: { status: "loading" } });
    try {
      this.set({ saveDraft: { status: "ready", inherited: await this.inherit() } });
    } catch (err) {
      this.set({ saveDraft: { status: "failed", error: EditorSession.failure(err) } });
    }
  }

  cancelSave(): void {
    this.set({ saveDraft: null });
  }

  /** Renders the full panorama and saves it as a new item; the source photos are untouched. */
  async save(choices: PublishChoices): Promise<void> {
    const draft = this.snapshot.saveDraft;
    if (draft?.status !== "ready") throw new PixError(ErrorCode.Internal, "Save was not prepared");
    this.set({ saveDraft: null });
    try {
      // Paragraph: full-resolution render, carrying the inherited EXIF.
      this.set({ phase: { name: "saving", step: "Building the full-size panorama…" } });
      const render = await this.renderFull(draft.inherited, choices.matchDate);

      // Paragraph: upload as a new item, then put it where its photos are.
      this.set({ phase: { name: "saving", step: "Uploading to Google Photos…" } });
      const used = this.snapshot.sources.filter((s) => render.used.includes(s.key));
      const fileName = PanoramaPublisher.outputName(used[0]?.item?.fileName ?? null);
      const published = await new PanoramaPublisher(this.#gateway).publish(render.image, fileName, draft.inherited, choices);

      // Paragraph: record provenance.
      this.#saved = { blob: render.image };
      await this.commitJob({
        status: "done",
        settings: this.snapshot.settings,
        usedMediaKeys: used.map((s) => s.mediaKey),
        usedDedupKeys: used.flatMap((s) => (s.item ? [s.item.dedupKey] : [])),
        saved: { mediaKey: published.created.ref.mediaKey, webUrl: published.created.webUrl, fileName, width: render.width, height: render.height },
        inherited: {
          takenAtMs: choices.matchDate ? draft.inherited.takenAtMs : null,
          location: draft.inherited.location !== null,
          description: published.descriptionSet,
          albums: published.albumsAdded.map((a) => a.title),
          problems: published.problems.map((p) => p.message),
        },
        error: null,
      });
      this.set({ phase: { name: "saved" }, progress: null, published });
    } catch (err) {
      const error = EditorSession.failure(err);
      await this.commitJob({ status: "failed", error }).catch((e: unknown) => console.error("[pixlixir] could not record the failure", e));
      this.set({ phase: { name: "ready" }, progress: null, previewError: error });
    }
  }

  /** Renders the full panorama (with inherited EXIF) and downloads it locally (no library change). */
  async download(): Promise<void> {
    const prior = this.snapshot.phase;
    try {
      this.set({ phase: { name: "saving", step: "Building the full-size panorama…" } });
      const blob = this.#saved?.blob ?? (await this.renderFull(await this.inherit(), true)).image;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = PanoramaPublisher.outputName(this.snapshot.sources.find((s) => s.item)?.item?.fileName ?? null);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      this.set({ phase: prior.name === "saved" ? prior : { name: "ready" }, progress: null });
    } catch (err) {
      this.set({ phase: { name: "ready" }, progress: null, previewError: EditorSession.failure(err) });
    }
  }

  private inherit(): Promise<InheritedMetadata> {
    const items = this.snapshot.sources.filter((s) => s.included && s.status === "ready" && s.item).map((s) => s.item!);
    return MetadataInheritance.collect(this.#gateway, items.map((i) => ({ mediaKey: i.ref.mediaKey, takenAtMs: i.takenAtMs, timezoneOffsetMs: i.timezoneOffsetMs })));
  }

  private renderFull(inherited: InheritedMetadata, matchDate: boolean): Promise<PanoramaRender> {
    const earliest = this.snapshot.sources.find((s) => s.mediaKey === inherited.earliestMediaKey);
    const metadata = MetadataInheritance.outputMetadata(inherited, earliest ? (this.#heads.get(earliest.key) ?? null) : null, matchDate);
    return this.#worker.stitch(this.includedKeys(), this.snapshot.settings, { kind: "full", maxMegapixels: PanoramaSession.QUALITY_MEGAPIXELS[this.snapshot.quality], metadata });
  }

  // ---- internals -----------------------------------------------------------------

  private source(key: number): PanoramaSource {
    const s = this.snapshot.sources.find((x) => x.key === key);
    if (!s) throw new PixError(ErrorCode.Internal, "Unknown panorama source", { key });
    return s;
  }

  private patchSource(key: number, patch: Partial<PanoramaSource>): void {
    this.set({ sources: this.snapshot.sources.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  }

  private async commitJob(patch: Partial<PanoramaJob>): Promise<void> {
    const job = this.snapshot.job;
    if (!job || !this.#store) throw new PixError(ErrorCode.StorageFailed, "No panorama job is open");
    this.set({ job: await this.#store.put({ ...job, ...patch }) });
  }

  static outputName(sourceName: string | null): string {
    return PanoramaPublisher.outputName(sourceName);
  }
}
