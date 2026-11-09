/**
 * The Upscale panel's state and work (ADR-0010), owned by the Edit page. It previews one area as
 * the settings change, and on Apply enlarges the whole photo into a new version. Everything runs
 * on this computer; nothing is sent anywhere.
 */

import { Upscaler, type UpscaleFactor } from "../../../imaging/upscale/upscaler.js";
import { ErrorCode, PixError, type SerializedError } from "../../../shared/errors.js";
import type { EditStep } from "../../storage/job-store.js";
import type { UpscaleDevice } from "./ort-upscale-model.js";
import { UpscaleWorkerClient } from "./upscale-client.js";

export interface UpscaleView {
  factor: UpscaleFactor;
  /** 0 keeps grain and noise, 1 smooths them away. */
  smooth: number;
  device: UpscaleDevice;
  /** Whether WebGPU found a GPU; null while asking. */
  gpu: boolean | null;
  /** Which sizes this photo can be enlarged to. */
  fits: Record<UpscaleFactor, boolean>;
  /** Centre of the previewed area, 0..1. */
  point: { u: number; v: number };
  preview: { beforeUrl: string; afterUrl: string; ms: number } | null;
  busy: "starting" | "preview" | "run" | null;
  progress: { done: number; total: number } | null;
  error: SerializedError | null;
}

export class UpscaleController {
  /** Side of the previewed area in the photo's pixels; shown 4x. */
  static readonly PREVIEW_SIDE = 128;
  static readonly DEFAULT_SMOOTH = 0.5;
  private static readonly DEBOUNCE_MS = 200;

  #view: UpscaleView;
  readonly #worker: UpscaleWorkerClient;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #generation = 0;
  #disposed = false;

  /** Starts the worker. The caller must call dispose(). */
  constructor(width: number, height: number, private readonly publish: (view: UpscaleView | null) => void) {
    const fits = { 2: Upscaler.fits(width, height, 2), 4: Upscaler.fits(width, height, 4) };
    this.#view = { factor: fits[4] && Math.max(width, height) <= 1200 ? 4 : 2, smooth: UpscaleController.DEFAULT_SMOOTH, device: "gpu", gpu: null, fits, point: { u: 0.5, v: 0.5 }, preview: null, busy: "starting", progress: null, error: null };
    this.#worker = new UpscaleWorkerClient((done, total) => this.set({ progress: { done, total } }));
    this.publish(this.#view);
  }

  /** Hands the photo over, learns whether there is a GPU, and makes the first preview. */
  async start(photo: ImageBitmap): Promise<void> {
    try {
      // Paragraph: nothing to do if even 2x is too large.
      if (!this.#view.fits[2]) {
        throw new PixError(ErrorCode.OutOfMemory, `This photo is already large: enlarged it would be over ${Upscaler.MAX_OUTPUT_MEGAPIXELS} megapixels.`, { width: photo.width, height: photo.height });
      }

      // Paragraph: the photo, and the device to start on: the GPU when there is one.
      await this.#worker.load(await createImageBitmap(photo));
      const gpu = await this.#worker.gpuAvailable();
      this.set({ gpu, device: gpu ? "gpu" : "cpu", busy: null });
      this.schedulePreview(0);
    } catch (err) {
      this.set({ busy: null, error: UpscaleController.failure(err) });
    }
  }

  get view(): UpscaleView {
    return this.#view;
  }

  /** Changes a setting; the preview follows. The size does not change the preview. */
  choose(patch: Partial<Pick<UpscaleView, "factor" | "smooth" | "device" | "point">>): void {
    if (this.#view.busy === "run") return;
    if (patch.factor && !this.#view.fits[patch.factor]) return;
    if (patch.device === "gpu" && !this.#view.gpu) return;
    this.set({ ...patch, error: null });
    if (patch.smooth !== undefined || patch.device !== undefined || patch.point !== undefined) this.schedulePreview(UpscaleController.DEBOUNCE_MS);
  }

  /** Enlarges the whole photo. Resolves to the new picture and what made it, or null on failure (shown in the panel). */
  async apply(): Promise<{ bitmap: ImageBitmap; step: EditStep } | null> {
    const { factor, smooth, device } = this.#view;
    this.#generation++;
    this.set({ busy: "run", progress: null, error: null });
    try {
      const { bitmap } = await this.#worker.run({ factor, smooth, device });
      this.set({ busy: null, progress: null });
      return { bitmap, step: { by: `Upscale ${factor}x`, prompt: `smooth ${smooth.toFixed(2)}, ${device}` } };
    } catch (err) {
      this.set({ busy: null, progress: null, error: UpscaleController.failure(err) });
      return null;
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#generation++;
    this.#worker.dispose();
    this.revokePreview();
    this.#view = { ...this.#view, preview: null };
    this.publish(null);
  }

  private schedulePreview(delayMs: number): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.preview(), delayMs);
  }

  private async preview(): Promise<void> {
    // Paragraph: one preview at a time; a newer request makes an older answer stale.
    const generation = ++this.#generation;
    const { point, smooth, device } = this.#view;
    this.set({ busy: "preview" });
    try {
      const r = await this.#worker.preview({ u: point.u, v: point.v, side: UpscaleController.PREVIEW_SIDE, smooth, device });
      if (generation !== this.#generation || this.#disposed) return;
      this.revokePreview();
      this.set({ busy: null, preview: { beforeUrl: URL.createObjectURL(r.before), afterUrl: URL.createObjectURL(r.after), ms: r.ms } });
    } catch (err) {
      if (generation === this.#generation) this.set({ busy: null, error: UpscaleController.failure(err) });
    }
  }

  private revokePreview(): void {
    const p = this.#view.preview;
    if (p) { URL.revokeObjectURL(p.beforeUrl); URL.revokeObjectURL(p.afterUrl); }
  }

  private set(patch: Partial<UpscaleView>): void {
    if (this.#disposed) return;
    this.#view = { ...this.#view, ...patch };
    this.publish(this.#view);
  }

  private static failure(err: unknown): SerializedError {
    return (err instanceof PixError ? err : PixError.wrap(err, ErrorCode.LocalEngineFailed, "Upscaling failed")).toJSON();
  }
}
