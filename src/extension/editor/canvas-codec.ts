/** Browser-only image decode/encode through OffscreenCanvas (usable in workers and pages). */

import type { RgbaImage } from "../../imaging/raster.js";
import { ErrorCode, PixError } from "../../shared/errors.js";

export class CanvasCodec {
  /** Draws a bitmap into RGBA pixels and closes the bitmap. */
  static decode(bitmap: ImageBitmap): RgbaImage {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new PixError(ErrorCode.MediaDecodeFailed, "2D canvas unavailable");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: data.width, height: data.height, data: data.data };
  }

  static async encode(img: RgbaImage, type: string, quality: number): Promise<Blob> {
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PixError(ErrorCode.MediaDecodeFailed, "2D canvas unavailable");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return canvas.convertToBlob({ type, quality });
  }

  /** Small JPEG thumbnail of an image blob (for source lists). */
  static async thumbnail(blob: Blob, maxSide: number): Promise<Blob> {
    const probe = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(probe.width, probe.height));
    const w = Math.max(1, Math.round(probe.width * scale)), h = Math.max(1, Math.round(probe.height * scale));
    probe.close();
    const bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PixError(ErrorCode.MediaDecodeFailed, "2D canvas unavailable");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  }
}
