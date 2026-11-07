/**
 * Edit with AI controller (ADR-0009). Owns the photo and its versions, the brush, the prompt, the
 * hand-over to a site or local engine, and the built-in fixes. The user brings a site's result back:
 * nothing here reads a site's answer. The original is never modified; a version is saved as a new item.
 */

import type { MediaItemInfo } from "../../../domain/types.js";
import { EditRegion, type PixelRect } from "../../../imaging/edit/edit-region.js";
import { ExifCarry } from "../../../imaging/edit/exif-carry.js";
import { EditMarking, PasteBack, ResultFit, type FitEstimate } from "../../../imaging/edit/result-fit.js";
import { AdjustmentPresets, type Adjustments, type BrushStroke } from "../../../imaging/enhance/adjustments.js";
import type { Quad } from "../../../imaging/geometry.js";
import type { RgbaImage } from "../../../imaging/raster.js";
import { ErrorCode, PixError, type SerializedError } from "../../../shared/errors.js";
import { JobStore, type EditJob, type EditStep } from "../../storage/job-store.js";
import { TOOLS } from "../../tools.js";
import { EditorSession, type EditorParams } from "../editor-session.js";
import type { FixController, FixTarget, FixView } from "../fix/fix-controller.js";
import { MetadataInheritance, PanoramaPublisher, PanoramaSourceLoader, type InheritedMetadata, type PublishChoices, type PublishedPanorama } from "../panorama/panorama-pipeline.js";
import { PhotosGateway } from "../photos-gateway.js";
import { ServiceSignIn, ServiceStore, type AiService, type SignIn } from "./ai-services.js";
import { EDIT_PRESETS, EditPrompt, type EditPresetId } from "./edit-presets.js";
import { LocalEngine, type EngineModel } from "./local-engines.js";
import { ResultInput, type BroughtBack } from "./result-input.js";
import { SiteFiller, type FillStep } from "./site-filler.js";
import { SplitWorkerClient } from "../worker-client.js";

export type EditPhase = { name: "loading"; step: string } | { name: "ready" } | { name: "saving"; step: string } | { name: "saved" } | { name: "failed"; error: SerializedError };

export interface EditCandidate {
  id: string;
  previewUrl: string;
  width: number;
  height: number;
  /** Null when the result replaces the whole photo. */
  fit: FitEstimate | null;
}

/** How placing the picture on the site went. */
export type EditFill = { state: "idle" | "working" | "sent" | "filled" } | { state: "failed"; step: FillStep | "refused" | "site" };

export interface EditHandover {
  /** A local engine: nothing to carry, so no site or clipboard. */
  engine: boolean;
  fill: EditFill;
  sentUrl: string;
  width: number;
  height: number;
  /** Null when the whole photo was sent. */
  region: PixelRect | null;
  prompt: string;
  copied: "picture" | "prompt" | null;
  candidates: EditCandidate[];
  adding: boolean;
  error: SerializedError | null;
}

export type EditSaveDraft = { status: "loading" } | { status: "ready"; inherited: InheritedMetadata } | { status: "failed"; error: SerializedError };

export interface EditSnapshot {
  params: EditorParams;
  phase: EditPhase;
  item: MediaItemInfo | null;
  size: { width: number; height: number } | null;
  shownUrl: string | null;
  /** The version before this one, for comparing. */
  previousUrl: string | null;
  versions: number;
  strokes: BrushStroke[];
  presetId: EditPresetId;
  text: string;
  services: AiService[];
  serviceId: string;
  signIn: Record<string, SignIn>;
  /** Press send on the site as well as filling its box. */
  autoSend: boolean;
  /** The chosen local engine's models. Null while unknown. */
  engineModels: { list: EngineModel[]; current: string | null } | null;
  /** A model is being read or loaded on the server. */
  engineBusy: boolean;
  /** How far a local engine may stray from the picture. */
  strength: number;
  handover: EditHandover | null;
  fix: FixView | null;
  fixTarget: FixTarget | null;
  saveDraft: EditSaveDraft | null;
  published: PublishedPanorama | null;
  notice: SerializedError | null;
}

interface Version {
  bitmap: ImageBitmap;
  url: string;
  /** What made this version; null for the photo as it came. */
  step: EditStep | null;
}

interface Sent {
  blob: Blob;
  /** The same picture without the marking, for an engine that takes a real mask. */
  clean: Blob;
  /** White where the brush is. */
  mask: Blob | null;
  step: EditStep;
  region: PixelRect | null;
  /** The sent area without its marking, small, to line results up against. */
  small: RgbaImage | null;
  smallBrush: Float32Array | null;
  /** The brush at full size over the region. */
  brush: Float32Array | null;
}

export class EditSession extends EditorSession<EditSnapshot> implements FixController {
  /** Longest side of a picture sent to a service. */
  static readonly MAX_SEND_SIDE = 2048;
  private static readonly PREVIEW_SIDE = 2400;
  private static readonly FIT_SIDE = 64;
  private static readonly SEND_MIME = "image/png";
  private static readonly FIX_ID = "photo";
  private static readonly FIX_DEBOUNCE_MS = 120;
  private static readonly DOWNLOAD_URL_MS = 60_000;
  private static readonly DEFAULT_STRENGTH = 0.75;

  readonly #gateway: PhotosGateway;
  readonly #services: ServiceStore;
  readonly #versions: Version[] = [];
  readonly #candidates = new Map<string, { bitmap: ImageBitmap; url: string }>();
  #head: Uint8Array | null = null;
  #sent: Sent | null = null;
  #engineRun: AbortController | null = null;
  #engineAsk: AbortController | null = null;
  #fixWorker: SplitWorkerClient | null = null;
  #fixTimer: ReturnType<typeof setTimeout> | null = null;
  #fixGeneration = 0;

  constructor(params: EditorParams) {
    super({
      params,
      phase: { name: "loading", step: "Downloading the photo…" },
      item: null, size: null, shownUrl: null, previousUrl: null, versions: 0, strokes: [],
      presetId: "erase", text: EditPrompt.preset("erase").text, services: [], serviceId: "chatgpt", signIn: {}, autoSend: true, engineModels: null, engineBusy: false, strength: EditSession.DEFAULT_STRENGTH,
      handover: null, fix: null, fixTarget: null, saveDraft: null, published: null, notice: null,
    });
    this.#gateway = new PhotosGateway(params.email, params.tabId);
    this.#services = new ServiceStore(params.email);
  }

  static paramsFromUrl(search: string): EditorParams {
    return EditorSession.parseParams(search, { min: TOOLS.edit.minPhotos, max: TOOLS.edit.maxPhotos });
  }

  dispose(): void {
    this.#engineRun?.abort();
    this.#engineAsk?.abort();
    this.endFix();
    for (const v of this.#versions) { v.bitmap.close(); URL.revokeObjectURL(v.url); }
    this.clearCandidates();
    if (this.snapshot.handover) URL.revokeObjectURL(this.snapshot.handover.sentUrl);
  }

  // ---- loading ---------------------------------------------------------------

  async init(): Promise<void> {
    try {
      // Paragraph: this account's services and what can be said about sign-in.
      await this.refreshServices();

      // Paragraph: the original, upright, with its header kept for saving.
      const mediaKey = this.snapshot.params.mediaKeys[0]!;
      const item = await this.#gateway.getItem(mediaKey);
      if (item.type === "video") throw new PixError(ErrorCode.InvalidImage, "Videos can't be edited yet.", { mediaKey });
      const blob = await this.#gateway.downloadOriginal(mediaKey);
      this.#head = new Uint8Array(await blob.slice(0, PanoramaSourceLoader.HEAD_BYTES).arrayBuffer());
      const bitmap = await createImageBitmap(blob).catch((err: unknown) => {
        throw PixError.wrap(err, ErrorCode.MediaDecodeFailed, `This browser can't decode ${item.fileName ?? "this photo"} (${blob.type}).`, { mimeType: blob.type });
      });

      // Paragraph: ready to brush.
      await this.pushVersion(bitmap, null);
      this.set({ item, phase: { name: "ready" } });
    } catch (err) {
      this.fail(err);
    }
  }

  async refreshServices(): Promise<void> {
    const saved = await this.#services.load();
    const services = await this.#services.list();
    const signIn = await ServiceSignIn.read(services);
    const chosen = services.find((s) => s.id === saved.chosen) ?? services.find((s) => signIn[s.id] === "in") ?? services[0]!;
    this.set({ services, signIn, serviceId: chosen.id, autoSend: saved.autoSend });
    void this.loadModels();
  }

  /** Asks for the sign-in permission. Runs from a click. */
  async checkSignIn(): Promise<void> {
    try {
      if (await ServiceSignIn.request()) await this.refreshServices();
    } catch (err) {
      this.set({ notice: EditorSession.failure(err) });
    }
  }

  chooseService(id: string): void {
    this.set({ serviceId: id });
    void this.#services.choose(id).catch((err: unknown) => this.set({ notice: EditorSession.failure(err) }));
    void this.loadModels();
  }

  // ---- the local engine's models ----------------------------------------------------

  private engine(): LocalEngine | null {
    const service = this.service();
    return service?.engine ? LocalEngine.create(service.engine, service.url) : null;
  }

  /** Asks the server which models it has. Also the Refresh button, after the user adds or removes one. */
  async loadModels(): Promise<void> {
    await this.askEngine(async (engine, signal) => this.set({ engineModels: await engine.models(signal) }), true);
  }

  /** Makes a model the server's current one. */
  async chooseModel(id: string): Promise<void> {
    await this.askEngine(async (engine, signal) => {
      await engine.useModel(id, signal);
      const known = this.snapshot.engineModels;
      if (known) this.set({ engineModels: { ...known, current: id } });
    }, false);
  }

  private async askEngine(ask: (engine: LocalEngine, signal: AbortSignal) => Promise<void>, forget: boolean): Promise<void> {
    this.#engineAsk?.abort();
    this.#engineAsk = null;
    const engine = this.engine();
    this.set(forget ? { engineModels: null, engineBusy: engine !== null } : { engineBusy: engine !== null });
    if (!engine) return;
    const run = new AbortController();
    this.#engineAsk = run;
    try {
      await ask(engine, run.signal);
      this.set({ notice: null, engineBusy: false });
    } catch (err) {
      if (!run.signal.aborted) this.set({ notice: EditorSession.failure(err), engineBusy: false });
    }
  }

  setStrength(strength: number): void {
    this.set({ strength });
  }

  private currentModel(): EngineModel | null {
    const known = this.snapshot.engineModels;
    return known?.list.find((m) => m.id === known.current) ?? null;
  }

  /** Whether the current model can take a strength. */
  hasStrength(): boolean {
    return this.currentModel()?.hasStrength === true;
  }

  setAutoSend(autoSend: boolean): void {
    this.set({ autoSend });
    void this.#services.setAutoSend(autoSend).catch((err: unknown) => this.set({ notice: EditorSession.failure(err) }));
  }

  private service(): AiService | null {
    return this.snapshot.services.find((s) => s.id === this.snapshot.serviceId) ?? null;
  }

  // ---- brush and prompt --------------------------------------------------------

  choosePreset(id: EditPresetId): void {
    this.set({ presetId: id, text: EDIT_PRESETS.find((p) => p.id === id)!.text });
  }

  setText(text: string): void {
    this.set({ text });
  }

  addBrushStroke(stroke: BrushStroke): void {
    this.set({ strokes: [...this.snapshot.strokes, stroke] });
  }

  undoBrushStroke(): void {
    this.set({ strokes: this.snapshot.strokes.slice(0, -1) });
  }

  clearStrokes(): void {
    this.set({ strokes: [] });
  }

  /** The chosen model can only fill a brushed area, and there is none yet. Text alone is enough for everything else. */
  needsBrush(): boolean {
    const engine = this.engine();
    if (!engine || this.snapshot.strokes.length > 0) return false;
    return this.currentModel()?.needsBrush ?? engine.needsBrush;
  }

  /** The text says "it" with nothing brushed to point at. */
  needsTarget(): boolean {
    const { presetId, text, strokes } = this.snapshot;
    return EditPrompt.needsTarget(EditPrompt.preset(presetId), text, strokes.length);
  }

  canSend(): boolean {
    const { phase, presetId, text, strokes, engineBusy } = this.snapshot;
    return phase.name === "ready" && !engineBusy && !this.needsBrush() && EditPrompt.ready(EditPrompt.preset(presetId), text, strokes.length);
  }

  // ---- hand-over to a service ---------------------------------------------------

  /** The Send button. Chrome only asks for a permission straight from a click, so asking comes first. */
  send(): void {
    const service = this.service();
    if (!this.canSend() || !service) return;
    if (service.engine) {
      void this.prepareHandover(service).then(() => this.runEngine());
      return;
    }
    const allowed = SiteFiller.request(service.url);
    void this.prepareHandover(service).then(() => this.deliver(service, allowed));
  }

  /** Delivers the same picture again, from the dialog. */
  sendAgain(): void {
    const service = this.service();
    if (!service) return;
    if (service.engine) void this.runEngine();
    else void this.deliver(service, SiteFiller.request(service.url));
  }

  /** Builds the picture to send and opens the waiting dialog. */
  private async prepareHandover(service: AiService): Promise<void> {
    try {
      const { strokes, text } = this.snapshot;
      const sent = await this.buildSent(strokes, { by: service.name, prompt: text.trim() });
      this.#sent = sent;
      const bitmap = await createImageBitmap(sent.blob);
      this.set({
        handover: { engine: service.engine !== undefined, fill: { state: "idle" }, sentUrl: URL.createObjectURL(sent.blob), width: bitmap.width, height: bitmap.height, region: sent.region, prompt: EditPrompt.compose(text, strokes.length > 0), copied: null, candidates: [], adding: false, error: null },
        notice: null,
      });
      bitmap.close();
    } catch (err) {
      this.set({ notice: EditorSession.failure(err) });
    }
  }

  /** Opens the site, then fills its box once. Whatever cannot be done there is left for the user, with the picture copied. */
  private async deliver(service: AiService, allowed: Promise<boolean>): Promise<void> {
    const sent = this.#sent, h = this.snapshot.handover;
    if (!sent || !h) return;
    this.patchHandover({ fill: { state: "working" }, error: null });
    try {
      // Paragraph: Chrome's question first: a new window would hide it.
      const mayFill = await allowed;
      await this.copyPicture();
      const tabId = await this.openWindow(service);
      if (!mayFill) {
        this.patchHandover({ fill: { state: "failed", step: "refused" } });
        return;
      }

      // Paragraph: one attempt per click, so nothing is ever sent twice.
      const outcome = await SiteFiller.fill(tabId, sent.blob, h.prompt, this.snapshot.autoSend);
      if (outcome.ok) this.patchHandover({ fill: { state: outcome.sent ? "sent" : "filled" }, error: null });
      else this.patchHandover({ fill: { state: "failed", step: outcome.step } });
    } catch (err) {
      this.patchHandover({ fill: { state: "failed", step: "site" }, error: PixError.wrap(err, ErrorCode.SiteFillFailed, `${service.name} could not be filled. Paste it yourself.`).toJSON() });
    }
  }

  /** Sends the picture and exact brush to the user's own engine, and offers what comes back. */
  private async runEngine(): Promise<void> {
    const engine = this.engine(), sent = this.#sent;
    if (!engine || !sent || !this.snapshot.handover) return;
    this.#engineRun?.abort();
    const run = new AbortController();
    this.#engineRun = run;
    this.patchHandover({ adding: true, error: null });
    try {
      const bitmap = await createImageBitmap(sent.clean);
      const { width, height } = bitmap;
      bitmap.close();

      // Paragraph: text alone: an engine whose call always takes a mask gets one covering the whole picture.
      const mask = sent.mask ?? (engine.alwaysNeedsMask ? await EditSession.maskBlob(new Float32Array(width * height).fill(1), width, height) : null);
      const result = await engine.run({ image: sent.clean, mask, width, height, prompt: sent.step.prompt ?? "", strength: this.snapshot.strength }, run.signal);
      await this.addCandidate(result);
      this.patchHandover({ adding: false });
    } catch (err) {
      if (!run.signal.aborted) this.patchHandover({ adding: false, error: EditorSession.failure(err) });
    }
  }

  private async buildSent(strokes: readonly BrushStroke[], step: EditStep): Promise<Sent> {
    const current = this.current();
    const { width: W, height: H } = current.bitmap;

    // Paragraph: no brush: the whole photo, at the size a service can take.
    const bounds = EditRegion.strokeBounds(strokes, W, H);
    if (!bounds) {
      const canvas = EditSession.canvasOf(current.bitmap, { x: 0, y: 0, width: W, height: H }, EditSession.MAX_SEND_SIDE);
      const blob = await canvas.convertToBlob({ type: EditSession.SEND_MIME });
      return { blob, clean: blob, mask: null, step, region: null, small: null, smallBrush: null, brush: null };
    }

    // Paragraph: a brush: the area around it, with the brush marked.
    const region = EditRegion.around(bounds, W, H);
    const relative = EditRegion.relative(strokes, region, W, H);
    const canvas = EditSession.canvasOf(current.bitmap, region, EditSession.MAX_SEND_SIDE);
    const ctx = EditSession.context(canvas);
    const cleanBlob = await canvas.convertToBlob({ type: EditSession.SEND_MIME });
    const clean = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sentBrush = EditRegion.mask(relative, clean.width, clean.height);
    const marked = EditMarking.mark({ width: clean.width, height: clean.height, data: clean.data }, sentBrush);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(marked.data), marked.width, marked.height), 0, 0);

    // Paragraph: small unmarked copy and brushes, to place what comes back.
    const smallCanvas = EditSession.canvasOf(current.bitmap, region, EditSession.FIT_SIDE);
    const smallData = EditSession.context(smallCanvas).getImageData(0, 0, smallCanvas.width, smallCanvas.height);
    return {
      blob: await canvas.convertToBlob({ type: EditSession.SEND_MIME }),
      clean: cleanBlob,
      mask: await EditSession.maskBlob(sentBrush, clean.width, clean.height),
      step,
      region,
      small: { width: smallData.width, height: smallData.height, data: smallData.data },
      smallBrush: EditRegion.mask(relative, smallData.width, smallData.height),
      brush: EditRegion.mask(relative, region.width, region.height),
    };
  }

  closeHandover(): void {
    this.#engineRun?.abort();
    this.#engineRun = null;
    const h = this.snapshot.handover;
    if (h) URL.revokeObjectURL(h.sentUrl);
    this.clearCandidates();
    this.#sent = null;
    this.set({ handover: null });
  }

  /** Copies the picture to send. Runs from a click. */
  async copyPicture(): Promise<void> {
    if (!this.#sent) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ [EditSession.SEND_MIME]: this.#sent.blob })]);
      this.patchHandover({ copied: "picture", error: null });
    } catch (err) {
      this.patchHandover({ error: PixError.wrap(err, ErrorCode.ClipboardFailed, "The picture could not be copied").toJSON() });
    }
  }

  async copyPrompt(): Promise<void> {
    const h = this.snapshot.handover;
    if (!h) return;
    try {
      await navigator.clipboard.writeText(h.prompt);
      this.patchHandover({ copied: "prompt", error: null });
    } catch (err) {
      this.patchHandover({ error: PixError.wrap(err, ErrorCode.ClipboardFailed, "The prompt could not be copied").toJSON() });
    }
  }

  /** Opens the service in a window of its own, on the right half of this monitor. Where it sits is only a convenience: if Chrome refuses the place, it still opens. */
  private async openWindow(service: AiService): Promise<number> {
    const area = screen as Screen & { availLeft?: number; availTop?: number };
    const width = Math.round(area.availWidth / 2);
    const place = { left: (area.availLeft ?? 0) + area.availWidth - width, top: area.availTop ?? 0, width, height: area.availHeight };
    const opened = await chrome.windows.create({ url: service.url, focused: true, type: "normal", ...place }).catch(() => chrome.windows.create({ url: service.url, focused: true, type: "normal" }));
    const tabId = opened?.tabs?.[0]?.id;
    if (tabId === undefined) throw new PixError(ErrorCode.Internal, `${service.name} could not be opened`);
    return tabId;
  }

  /** Takes what was pasted, dropped or typed as an address. */
  async bringBack(items: readonly BroughtBack[]): Promise<void> {
    if (items.length === 0) {
      this.patchHandover({ error: new PixError(ErrorCode.EditResultInvalid, "That has no picture in it.").toJSON() });
      return;
    }
    this.patchHandover({ adding: true, error: null });
    try {
      for (const item of items) await this.addCandidate(item.kind === "image" ? item.blob : await ResultInput.download(item.url));
      this.patchHandover({ adding: false });
    } catch (err) {
      this.patchHandover({ adding: false, error: EditorSession.failure(err) });
    }
  }

  private async addCandidate(blob: Blob): Promise<void> {
    const sent = this.#sent;
    if (!sent) throw new PixError(ErrorCode.Internal, "Nothing is waiting for a result");
    const result = await createImageBitmap(blob).catch((err: unknown) => {
      throw PixError.wrap(err, ErrorCode.EditResultInvalid, "That picture could not be read", { type: blob.type });
    });

    // Paragraph: no region: the result is the new photo. A region: paste only the brush.
    let bitmap = result;
    let fit: FitEstimate | null = null;
    if (sent.region) {
      fit = await this.placeResult(result, sent);
      bitmap = this.compose(result, sent, fit);
      result.close();
    }

    // Paragraph: offered for the user to pick.
    const id = crypto.randomUUID();
    const url = await EditSession.previewUrl(bitmap);
    this.#candidates.set(id, { bitmap, url });
    const h = this.snapshot.handover!;
    this.patchHandover({ candidates: [...h.candidates, { id, previewUrl: url, width: bitmap.width, height: bitmap.height, fit }] });
  }

  private async placeResult(result: ImageBitmap, sent: Sent): Promise<FitEstimate> {
    const small = EditSession.canvasOf(result, { x: 0, y: 0, width: result.width, height: result.height }, EditSession.FIT_SIDE);
    const data = EditSession.context(small).getImageData(0, 0, small.width, small.height);
    return ResultFit.estimate(sent.small!, { width: data.width, height: data.height, data: data.data }, sent.smallBrush!);
  }

  private compose(result: ImageBitmap, sent: Sent, fit: FitEstimate): ImageBitmap {
    const base = this.current().bitmap;
    const region = sent.region!;

    // Paragraph: the current photo, and the result placed over its region.
    const full = new OffscreenCanvas(base.width, base.height);
    const ctx = EditSession.context(full);
    ctx.drawImage(base, 0, 0);
    const top = new OffscreenCanvas(region.width, region.height);
    const topCtx = EditSession.context(top);
    topCtx.imageSmoothingQuality = "high";
    topCtx.drawImage(result, fit.rect.x * region.width, fit.rect.y * region.height, fit.rect.width * region.width, fit.rect.height * region.height);

    // Paragraph: only the brushed pixels change.
    const under = ctx.getImageData(region.x, region.y, region.width, region.height);
    const over = topCtx.getImageData(0, 0, region.width, region.height);
    const out = PasteBack.apply({ width: under.width, height: under.height, data: under.data }, { width: over.width, height: over.height, data: over.data }, sent.brush!);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), region.x, region.y);
    return full.transferToImageBitmap();
  }

  /** Makes a result the current version. */
  async useCandidate(id: string): Promise<void> {
    const chosen = this.#candidates.get(id);
    if (!chosen) return;
    this.#candidates.delete(id);
    URL.revokeObjectURL(chosen.url);
    await this.pushVersion(chosen.bitmap, this.#sent?.step ?? null);
    this.closeHandover();
    this.set({ strokes: [], published: null, notice: null });
    if (this.snapshot.phase.name === "saved") this.set({ phase: { name: "ready" } });
  }

  /** Keeps a result on this computer, without it ever reaching Google Photos. */
  async downloadCandidate(id: string): Promise<void> {
    const candidate = this.#candidates.get(id);
    if (candidate) await this.download(candidate.bitmap);
  }

  /** Keeps the current version on this computer. */
  async downloadCurrent(): Promise<void> {
    await this.download(this.current().bitmap);
  }

  private async download(bitmap: ImageBitmap): Promise<void> {
    const report = (error: SerializedError) => (this.snapshot.handover ? this.patchHandover({ error }) : this.set({ notice: error }));
    try {
      // Paragraph: the same file a save would make, with the original's details.
      const carried = this.carryExif(await EditSession.encode(bitmap));
      const url = URL.createObjectURL(new Blob([carried.bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = EditSession.outputName(this.snapshot.item?.fileName ?? null);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), EditSession.DOWNLOAD_URL_MS);
      if (carried.problems[0]) report(carried.problems[0]);
    } catch (err) {
      report(EditorSession.failure(err));
    }
  }

  undoVersion(): void {
    if (this.#versions.length < 2) return;
    const dropped = this.#versions.pop()!;
    dropped.bitmap.close();
    URL.revokeObjectURL(dropped.url);
    this.publishVersions();
    this.set({ published: null });
    if (this.snapshot.phase.name === "saved") this.set({ phase: { name: "ready" } });
  }

  // ---- built-in fixes (the Fix panel, on this computer) ---------------------------

  /** The Fix panel over the current version. Glare and lighting start off: they were made for scanned prints. */
  async openAutoFix(): Promise<void> {
    try {
      const { width, height } = this.current().bitmap;
      this.#fixWorker = new SplitWorkerClient();
      await this.#fixWorker.load(await createImageBitmap(this.current().bitmap));
      const auto = AdjustmentPresets.auto();
      this.set({
        fix: { targetId: EditSession.FIX_ID, fixedUrl: null, originalUrl: null, maskUrl: null, report: null, busy: true },
        fixTarget: { id: EditSession.FIX_ID, rotation: 0, adjustments: EditSession.forPhoto({ ...auto, glare: { ...auto.glare, enabled: false } }) },
        size: { width, height },
      });
      this.scheduleFix(0);
    } catch (err) {
      this.endFix();
      this.set({ notice: EditorSession.failure(err) });
    }
  }

  /** Lighting needs the surface around a scanned print, which a photo does not have. */
  private static forPhoto(adjustments: Adjustments): Adjustments {
    return { ...adjustments, lighting: { ...adjustments.lighting, enabled: false } };
  }

  setAdjustments(_id: string, adjustments: Adjustments): void {
    const target = this.snapshot.fixTarget;
    if (!target) return;
    this.set({ fixTarget: { ...target, adjustments: EditSession.forPhoto(adjustments) } });
    this.scheduleFix(EditSession.FIX_DEBOUNCE_MS);
  }

  addStroke(id: string, stroke: BrushStroke): void {
    const target = this.snapshot.fixTarget;
    if (target) this.setAdjustments(id, { ...target.adjustments, strokes: [...target.adjustments.strokes, stroke] });
  }

  undoStroke(id: string): void {
    const target = this.snapshot.fixTarget;
    if (target) this.setAdjustments(id, { ...target.adjustments, strokes: target.adjustments.strokes.slice(0, -1) });
  }

  rotate(_id: string, delta: 1 | -1): void {
    const { fixTarget: target, fix } = this.snapshot;
    if (!target || !fix) return;
    if (fix.originalUrl) URL.revokeObjectURL(fix.originalUrl);
    this.set({ fix: { ...fix, originalUrl: null }, fixTarget: { ...target, rotation: (target.rotation + delta + 4) % 4 } });
    this.scheduleFix(0);
  }

  /** Done: what the panel shows becomes the next version, at full size. No change makes no version. */
  closeFix(): void {
    void this.applyFix();
  }

  private async applyFix(): Promise<void> {
    const { fixTarget: target, fix } = this.snapshot;
    const worker = this.#fixWorker;
    if (!target || !fix || !worker) return;
    if (AdjustmentPresets.isIdentity(target.adjustments) && target.rotation === 0) {
      this.endFix();
      return;
    }
    this.#fixGeneration++;
    this.set({ fix: { ...fix, busy: true } });
    try {
      const { image } = await worker.render({ quad: this.fullQuad(), rotation: target.rotation, adjustments: target.adjustments, size: "full", wantMask: false });
      await this.pushVersion(await createImageBitmap(image), { by: "Auto fix", prompt: null });
      this.set({ strokes: [], published: null, notice: null });
      if (this.snapshot.phase.name === "saved") this.set({ phase: { name: "ready" } });
    } catch (err) {
      this.set({ notice: EditorSession.failure(err) });
    }
    this.endFix();
  }

  private fullQuad(): Quad {
    const { width: W, height: H } = this.current().bitmap;
    return [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  }

  private scheduleFix(delayMs: number): void {
    if (this.#fixTimer !== null) clearTimeout(this.#fixTimer);
    this.#fixTimer = setTimeout(() => void this.renderFix(), delayMs);
  }

  private async renderFix(): Promise<void> {
    const { fixTarget: target, fix } = this.snapshot;
    const worker = this.#fixWorker;
    if (!target || !fix || !worker) return;
    const generation = ++this.#fixGeneration;
    this.set({ fix: { ...fix, busy: true } });
    try {
      const base = { quad: this.fullQuad(), rotation: target.rotation, size: "preview" as const };
      const [fixed, original] = await Promise.all([
        worker.render({ ...base, adjustments: target.adjustments, wantMask: true }),
        fix.originalUrl ? Promise.resolve(null) : worker.render({ ...base, adjustments: AdjustmentPresets.none(), wantMask: false }),
      ]);
      const current = this.snapshot.fix;
      if (generation !== this.#fixGeneration || !current) return;
      for (const url of [current.fixedUrl, current.maskUrl]) if (url) URL.revokeObjectURL(url);
      this.set({ fix: { ...current, busy: false, fixedUrl: URL.createObjectURL(fixed.image), maskUrl: fixed.mask ? URL.createObjectURL(fixed.mask) : null, originalUrl: original ? URL.createObjectURL(original.image) : current.originalUrl, report: fixed.report } });
    } catch (err) {
      if (generation === this.#fixGeneration) {
        this.endFix();
        this.set({ notice: EditorSession.failure(err) });
      }
    }
  }

  /** Releases the panel's worker and previews. */
  private endFix(): void {
    if (this.#fixTimer !== null) clearTimeout(this.#fixTimer);
    this.#fixTimer = null;
    this.#fixGeneration++;
    this.#fixWorker?.dispose();
    this.#fixWorker = null;
    const fix = this.snapshot.fix;
    if (fix) for (const url of [fix.fixedUrl, fix.originalUrl, fix.maskUrl]) if (url) URL.revokeObjectURL(url);
    this.set({ fix: null, fixTarget: null });
  }

  // ---- saving -----------------------------------------------------------------

  async prepareSave(): Promise<void> {
    const item = this.snapshot.item;
    if (!item) return;
    this.set({ saveDraft: { status: "loading" } });
    try {
      const inherited = await MetadataInheritance.collect(this.#gateway, [{ mediaKey: item.ref.mediaKey, takenAtMs: item.takenAtMs, timezoneOffsetMs: item.timezoneOffsetMs }]);
      this.set({ saveDraft: { status: "ready", inherited } });
    } catch (err) {
      this.set({ saveDraft: { status: "failed", error: EditorSession.failure(err) } });
    }
  }

  cancelSave(): void {
    this.set({ saveDraft: null });
  }

  /** Saves the current version as a new item. The original stays as it is. */
  async save(choices: PublishChoices): Promise<void> {
    const draft = this.snapshot.saveDraft;
    if (draft?.status !== "ready") throw new PixError(ErrorCode.Internal, "Save was not prepared");
    this.set({ saveDraft: null, notice: null });
    let store: JobStore | null = null;
    let job: EditJob | null = null;
    try {
      // Paragraph: the record comes before the upload, with what made this version.
      store = await JobStore.open();
      const now = Date.now();
      job = await store.put<EditJob>({ id: crypto.randomUUID(), kind: "edit", accountEmail: this.snapshot.params.email, sourceMediaKey: this.snapshot.params.mediaKeys[0]!, sourceFileName: this.snapshot.item?.fileName ?? null, steps: this.#versions.flatMap((v) => v.step ?? []), status: "saving", saved: null, error: null, createdAt: now, updatedAt: now });

      // Paragraph: the current version as a JPEG, with the original's details when they can move.
      this.set({ phase: { name: "saving", step: "Preparing the file…" } });
      const encoded = await EditSession.encode(this.current().bitmap);
      const carried = this.carryExif(encoded);

      // Paragraph: a new item, in the same places as the original.
      this.set({ phase: { name: "saving", step: "Uploading to Google Photos…" } });
      const image = new Blob([carried.bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
      const fileName = EditSession.outputName(this.snapshot.item?.fileName ?? null);
      const published = await new PanoramaPublisher(this.#gateway).publish(image, fileName, draft.inherited, choices);
      await store.put<EditJob>({ ...job, status: "done", saved: { mediaKey: published.created.ref.mediaKey, webUrl: published.created.webUrl, fileName } });
      this.set({ phase: { name: "saved" }, published: { ...published, problems: [...carried.problems, ...published.problems] } });
    } catch (err) {
      const failure = EditorSession.failure(err);
      this.set({ phase: { name: "ready" }, notice: failure });
      if (store && job) await store.put<EditJob>({ ...job, status: "failed", error: failure }).catch((e: unknown) => console.error("[pixlixir] could not record a failed edit", e));
    } finally {
      store?.close();
    }
  }

  private carryExif(encoded: Uint8Array): { bytes: Uint8Array; problems: SerializedError[] } {
    try {
      return { bytes: ExifCarry.apply(encoded, this.#head!), problems: [] };
    } catch (err) {
      return { bytes: encoded, problems: [EditorSession.failure(err)] };
    }
  }

  static outputName(sourceName: string | null): string {
    const base = (sourceName ?? "photo").replace(/\.[^.]+$/, "").replace(/[^\w\- .~]+/g, "_").slice(0, 80) || "photo";
    return `${base}_edit.jpg`;
  }

  // ---- internals ---------------------------------------------------------------

  private current(): Version {
    const v = this.#versions[this.#versions.length - 1];
    if (!v) throw new PixError(ErrorCode.Internal, "No photo is loaded");
    return v;
  }

  private async pushVersion(bitmap: ImageBitmap, step: EditStep | null): Promise<void> {
    this.#versions.push({ bitmap, url: await EditSession.previewUrl(bitmap), step });
    this.publishVersions();
  }

  private publishVersions(): void {
    const v = this.current();
    this.set({ shownUrl: v.url, previousUrl: this.#versions[this.#versions.length - 2]?.url ?? null, versions: this.#versions.length, size: { width: v.bitmap.width, height: v.bitmap.height } });
  }

  private patchHandover(patch: Partial<EditHandover>): void {
    const h = this.snapshot.handover;
    if (h) this.set({ handover: { ...h, ...patch } });
  }

  private clearCandidates(): void {
    for (const c of this.#candidates.values()) { c.bitmap.close(); URL.revokeObjectURL(c.url); }
    this.#candidates.clear();
  }

  private static context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new PixError(ErrorCode.MediaDecodeFailed, "2D canvas unavailable");
    return ctx;
  }

  /** Draws part of a picture, shrunk if its longest side is above `maxSide`. */
  private static canvasOf(source: ImageBitmap, rect: PixelRect, maxSide: number): OffscreenCanvas {
    const scale = Math.min(1, maxSide / Math.max(rect.width, rect.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(rect.width * scale)), Math.max(1, Math.round(rect.height * scale)));
    const ctx = EditSession.context(canvas);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /** White where the brush covers more than half a pixel, black elsewhere, for an engine's mask. */
  private static async maskBlob(brush: Float32Array, width: number, height: number): Promise<Blob> {
    const canvas = new OffscreenCanvas(width, height);
    const pixels = new ImageData(width, height);
    for (let i = 0; i < brush.length; i++) {
      const value = brush[i]! > 0.5 ? 255 : 0;
      pixels.data.set([value, value, value, 255], i * 4);
    }
    EditSession.context(canvas).putImageData(pixels, 0, 0);
    return canvas.convertToBlob({ type: EditSession.SEND_MIME });
  }

  private static async previewUrl(bitmap: ImageBitmap): Promise<string> {
    const canvas = EditSession.canvasOf(bitmap, { x: 0, y: 0, width: bitmap.width, height: bitmap.height }, EditSession.PREVIEW_SIDE);
    return URL.createObjectURL(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 }));
  }

  private static async encode(bitmap: ImageBitmap): Promise<Uint8Array> {
    const canvas = EditSession.canvasOf(bitmap, { x: 0, y: 0, width: bitmap.width, height: bitmap.height }, Math.max(bitmap.width, bitmap.height));
    return new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 })).arrayBuffer());
  }
}
