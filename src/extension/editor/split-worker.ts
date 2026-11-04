/**
 * Web worker for scan splitting: decodes once, detects prints, and renders
 * rectified outputs (full-resolution JPEGs or small previews) off the UI thread.
 */

import type { Quad } from "../../imaging/geometry.js";
import { Raster, type RgbaImage } from "../../imaging/raster.js";
import { PrintDetector, type DetectedPrint } from "../../imaging/split/detector.js";
import { PerspectiveWarper } from "../../imaging/warp.js";
import { ErrorCode, PixError } from "../../shared/errors.js";

export type WorkerRequest =
  | { id: number; op: "load"; bitmap: ImageBitmap }
  | { id: number; op: "detect" }
  | { id: number; op: "render"; quad: Quad; rotation: number; preview: boolean };

export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: ReturnType<PixError["toJSON"]> };

class SplitWorker {
  static readonly PREVIEW_SIDE = 1400;
  #full: RgbaImage | null = null;
  #preview: { image: RgbaImage; scale: number } | null = null;

  handle(req: WorkerRequest): unknown {
    switch (req.op) {
      case "load":
        return this.load(req.bitmap);
      case "detect":
        return this.detect();
      case "render":
        return this.render(req.quad, req.rotation, req.preview);
    }
  }

  private load(bitmap: ImageBitmap): { width: number; height: number } {
    // Paragraph: decode into RGBA once; keep a downscaled copy for previews.
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new PixError(ErrorCode.MediaDecodeFailed, "2D canvas unavailable in worker");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    this.#full = { width: data.width, height: data.height, data: data.data };
    this.#preview = Raster.downscale(this.#full, SplitWorker.PREVIEW_SIDE);
    return { width: data.width, height: data.height };
  }

  private detect(): DetectedPrint[] {
    return new PrintDetector().detect(this.requireFull());
  }

  private async render(quad: Quad, rotation: number, preview: boolean): Promise<Blob> {
    // Paragraph: rectify (from the preview copy when previewing) and rotate.
    const full = this.requireFull();
    const src = preview && this.#preview ? this.#preview : { image: full, scale: 1 };
    const scaled = quad.map((p) => ({ x: p.x * src.scale, y: p.y * src.scale })) as Quad;
    const out = Raster.rotate90(PerspectiveWarper.rectify(src.image, scaled), rotation);

    // Paragraph: encode.
    const canvas = new OffscreenCanvas(out.width, out.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PixError(ErrorCode.MediaDecodeFailed, "2D canvas unavailable in worker");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height), 0, 0);
    return canvas.convertToBlob({ type: "image/jpeg", quality: preview ? 0.8 : 0.95 });
  }

  private requireFull(): RgbaImage {
    if (!this.#full) throw new PixError(ErrorCode.InvalidImage, "No image loaded in the split worker");
    return this.#full;
  }
}

const worker = new SplitWorker();
self.addEventListener("message", (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  Promise.resolve()
    .then(() => worker.handle(req))
    .then(
      (value) => self.postMessage({ id: req.id, ok: true, value } satisfies WorkerResponse),
      (err: unknown) => {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Split worker failed");
        self.postMessage({ id: req.id, ok: false, error: e.toJSON() } satisfies WorkerResponse);
      },
    );
});
