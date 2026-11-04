/**
 * Minimal raster types and helpers, independent of DOM canvas so they run in
 * workers and in Node tests.
 */

import { ErrorCode, PixError } from "../shared/errors.js";

/** Same layout as DOM ImageData (RGBA, 8-bit, row-major). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Single-channel 8-bit mask / gray image. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export class Raster {
  static createRgba(width: number, height: number): RgbaImage {
    Raster.assertSize(width, height);
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  static createGray(width: number, height: number): GrayImage {
    Raster.assertSize(width, height);
    return { width, height, data: new Uint8Array(width * height) };
  }

  static assertSize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new PixError(ErrorCode.InvalidImage, "Image dimensions must be positive integers", { width, height });
    }
  }

  static assertRgba(img: RgbaImage): void {
    Raster.assertSize(img.width, img.height);
    if (img.data.length !== img.width * img.height * 4) {
      throw new PixError(ErrorCode.InvalidImage, "RGBA buffer length does not match dimensions", { width: img.width, height: img.height, length: img.data.length });
    }
  }

  /** Box-filter downscale so the longest side is at most maxSide. Returns the scale factor used (dst = src * scale). */
  static downscale(src: RgbaImage, maxSide: number): { image: RgbaImage; scale: number } {
    Raster.assertRgba(src);
    const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
    if (scale === 1) return { image: src, scale: 1 };
    const w = Math.max(1, Math.round(src.width * scale));
    const h = Math.max(1, Math.round(src.height * scale));
    const dst = Raster.createRgba(w, h);
    const sx = src.width / w;
    const sy = src.height / h;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          let i = (yy * src.width + x0) * 4;
          for (let xx = x0; xx < x1; xx++, i += 4) {
            r += src.data[i]!; g += src.data[i + 1]!; b += src.data[i + 2]!; a += src.data[i + 3]!; n++;
          }
        }
        const o = (y * w + x) * 4;
        dst.data[o] = r / n; dst.data[o + 1] = g / n; dst.data[o + 2] = b / n; dst.data[o + 3] = a / n;
      }
    }
    return { image: dst, scale: w / src.width };
  }

  /** Rotate by a multiple of 90° clockwise. */
  static rotate90(src: RgbaImage, quarterTurns: number): RgbaImage {
    const t = ((quarterTurns % 4) + 4) % 4;
    if (t === 0) return src;
    const w = t % 2 === 0 ? src.width : src.height;
    const h = t % 2 === 0 ? src.height : src.width;
    const dst = Raster.createRgba(w, h);
    const s32 = new Uint32Array(src.data.buffer, src.data.byteOffset, src.width * src.height);
    const d32 = new Uint32Array(dst.data.buffer);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        let dx: number, dy: number;
        if (t === 1) { dx = src.height - 1 - y; dy = x; }
        else if (t === 2) { dx = src.width - 1 - x; dy = src.height - 1 - y; }
        else { dx = y; dy = src.width - 1 - x; }
        d32[dy * w + dx] = s32[y * src.width + x]!;
      }
    }
    return dst;
  }
}
