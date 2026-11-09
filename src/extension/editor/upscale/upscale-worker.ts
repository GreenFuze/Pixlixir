/**
 * Web worker for Upscale: holds the photo's pixels and the model, makes a quick preview of one
 * area, and enlarges the whole photo tile by tile, off the page's thread.
 */

import type { RgbaImage } from "../../../imaging/raster.js";
import { Upscaler, type UpscaleFactor } from "../../../imaging/upscale/upscaler.js";
import { ErrorCode, PixError } from "../../../shared/errors.js";
import { CanvasCodec } from "../canvas-codec.js";
import { WorkerRpcServer } from "../worker-rpc.js";
import { OrtUpscaleModel, type UpscaleDevice } from "./ort-upscale-model.js";

export interface PreviewRequest {
  /** Centre of the preview, 0..1 across and down the photo. */
  u: number;
  v: number;
  /** Side of the previewed area, in the photo's pixels. */
  side: number;
  smooth: number;
  device: UpscaleDevice;
}

export interface PreviewResult {
  /** The area enlarged 4x the plain way, then by the model. */
  before: Blob;
  after: Blob;
  ms: number;
}

export interface RunRequest {
  factor: UpscaleFactor;
  smooth: number;
  device: UpscaleDevice;
}

export type UpscaleWorkerRequest =
  | { id: number; op: "load"; bitmap: ImageBitmap }
  | { id: number; op: "gpu" }
  | ({ id: number; op: "preview" } & PreviewRequest)
  | ({ id: number; op: "run" } & RunRequest);

class UpscaleWorker {
  #photo: RgbaImage | null = null;
  #model: OrtUpscaleModel | null = null;

  handle(req: UpscaleWorkerRequest): unknown {
    switch (req.op) {
      case "load":
        this.#photo = CanvasCodec.decode(req.bitmap);
        return { width: this.#photo.width, height: this.#photo.height };
      case "gpu":
        return OrtUpscaleModel.gpuAvailable();
      case "preview":
        return this.preview(req);
      case "run":
        return this.run(req);
    }
  }

  private async preview(req: PreviewRequest): Promise<PreviewResult> {
    // Paragraph: the area around the chosen point, inside the photo.
    const photo = this.requirePhoto();
    const side = Math.min(req.side, photo.width, photo.height);
    const x = Math.round(Math.max(0, Math.min(photo.width - side, req.u * photo.width - side / 2)));
    const y = Math.round(Math.max(0, Math.min(photo.height - side, req.v * photo.height - side / 2)));
    const area = UpscaleWorker.cut(photo, x, y, side, side);

    // Paragraph: the model's 4x, and the same area simply enlarged, for comparing.
    const model = await this.modelOn(req.device);
    const t0 = performance.now();
    const canvas = new OffscreenCanvas(side * 4, side * 4);
    const ctx = UpscaleWorker.context(canvas);
    await new Upscaler(model).upscale(area, 4, req.smooth, { put: (tile, tx, ty) => ctx.putImageData(new ImageData(tile.data as Uint8ClampedArray<ArrayBuffer>, tile.width, tile.height), tx, ty) });
    const ms = Math.round(performance.now() - t0);
    const after = await canvas.convertToBlob({ type: "image/png" });
    const plain = new OffscreenCanvas(side * 4, side * 4);
    const pctx = UpscaleWorker.context(plain);
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(await createImageBitmap(new ImageData(area.data as Uint8ClampedArray<ArrayBuffer>, side, side)), 0, 0, side * 4, side * 4);
    return { before: await plain.convertToBlob({ type: "image/png" }), after, ms };
  }

  private async run(req: RunRequest): Promise<{ bitmap: ImageBitmap; ms: number }> {
    // Paragraph: tiles go straight onto a canvas of the result's size.
    const photo = this.requirePhoto();
    const model = await this.modelOn(req.device);
    const t0 = performance.now();
    const canvas = new OffscreenCanvas(photo.width * req.factor, photo.height * req.factor);
    const ctx = UpscaleWorker.context(canvas);
    await new Upscaler(model).upscale(photo, req.factor, req.smooth, { put: (tile, x, y) => ctx.putImageData(new ImageData(tile.data as Uint8ClampedArray<ArrayBuffer>, tile.width, tile.height), x, y) }, (done, total) => WorkerRpcServer.emit("progress", { done, total }));
    const bitmap = canvas.transferToImageBitmap();
    return WorkerRpcServer.transfer({ bitmap, ms: Math.round(performance.now() - t0) }, [bitmap]);
  }

  /** The model on this device, loaded once and kept until the device changes. */
  private async modelOn(device: UpscaleDevice): Promise<OrtUpscaleModel> {
    if (this.#model?.device === device) return this.#model;
    await this.#model?.release();
    this.#model = null;
    this.#model = await OrtUpscaleModel.load(device, new URL("./", self.location.href));
    return this.#model;
  }

  private requirePhoto(): RgbaImage {
    if (!this.#photo) throw new PixError(ErrorCode.Internal, "No photo is loaded in the upscaler.");
    return this.#photo;
  }

  private static cut(src: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) data.set(src.data.subarray(((y + r) * src.width + x) * 4, ((y + r) * src.width + x + w) * 4), r * w * 4);
    return { width: w, height: h, data };
  }

  private static context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PixError(ErrorCode.OutOfMemory, "The browser could not make a canvas this large.", { width: canvas.width, height: canvas.height });
    return ctx;
  }
}

const worker = new UpscaleWorker();
WorkerRpcServer.serve<UpscaleWorkerRequest>((req) => worker.handle(req), "Upscaling failed");
