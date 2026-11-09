/**
 * Upscaling with Real-ESRGAN's compact general model (ADR-0010), independent of where the model runs.
 *
 * The model enlarges 4x and takes a smoothing setting: 0 keeps noise and film grain, 1 smooths them
 * away. A photo is cut into tiles with a margin, so each tile sees its neighbours and the seams do
 * not show, and so the GPU never holds the whole photo. 2x is the 4x result averaged over 2 x 2
 * pixels, as Real-ESRGAN's own "outscale" does.
 */

import { ErrorCode, PixError } from "../../shared/errors.js";
import { Raster, type RgbaImage } from "../raster.js";

/** Runs the model on one tile: planar RGB 0..1, [3, h, w] in, [3, 4h, 4w] out. */
export interface UpscaleModel {
  run(rgb: Float32Array, width: number, height: number, smooth: number): Promise<Float32Array>;
}

export type UpscaleFactor = 2 | 4;

/** One tile: the part it writes, and the larger part it reads so its edges see their neighbours. */
export interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
  readX: number;
  readY: number;
  readWidth: number;
  readHeight: number;
}

export class TilePlan {
  /** Tile side, in source pixels. */
  static readonly SIDE = 192;
  /** Margin read around each tile. Real-ESRGAN uses 10; the model sees 34 pixels each way. */
  static readonly MARGIN = 16;

  static of(width: number, height: number, side = TilePlan.SIDE, margin = TilePlan.MARGIN): Tile[] {
    Raster.assertSize(width, height);
    const tiles: Tile[] = [];
    for (let y = 0; y < height; y += side) {
      for (let x = 0; x < width; x += side) {
        const w = Math.min(side, width - x), h = Math.min(side, height - y);
        const readX = Math.max(0, x - margin), readY = Math.max(0, y - margin);
        tiles.push({ x, y, width: w, height: h, readX, readY, readWidth: Math.min(width, x + w + margin) - readX, readHeight: Math.min(height, y + h + margin) - readY });
      }
    }
    return tiles;
  }
}

/** Where finished tiles go: a whole picture in tests, a canvas in the page. */
export interface TileSink {
  put(tile: RgbaImage, x: number, y: number): void | Promise<void>;
}

export class Upscaler {
  static readonly MODEL_SCALE = 4;
  /** The largest result made: about 8000 x 6000. Larger would not fit a canvas or a 45 MB upload. */
  static readonly MAX_OUTPUT_MEGAPIXELS = 50;

  constructor(private readonly model: UpscaleModel) {}

  /** Whether a photo of this size can be enlarged this much. */
  static fits(width: number, height: number, factor: UpscaleFactor): boolean {
    return (width * factor * height * factor) / 1e6 <= Upscaler.MAX_OUTPUT_MEGAPIXELS;
  }

  /** Enlarges `source` by `factor`, tile by tile, into `sink`. `smooth` is 0 (keep grain) to 1 (smooth it away). */
  async upscale(source: RgbaImage, factor: UpscaleFactor, smooth: number, sink: TileSink, onTile: (done: number, total: number) => void = () => {}, signal?: AbortSignal): Promise<{ width: number; height: number }> {
    // Paragraph: check the request before any work.
    Raster.assertRgba(source);
    if (!(smooth >= 0 && smooth <= 1)) throw new PixError(ErrorCode.InvalidImage, "Smoothing must be between 0 and 1.", { smooth });
    if (!Upscaler.fits(source.width, source.height, factor)) {
      throw new PixError(ErrorCode.OutOfMemory, `Too large to enlarge ${factor}x: the result would be over ${Upscaler.MAX_OUTPUT_MEGAPIXELS} megapixels.`, { width: source.width, height: source.height, factor });
    }

    // Paragraph: each tile through the model, its margin cut away, shrunk for 2x, then handed on.
    const tiles = TilePlan.of(source.width, source.height);
    for (let i = 0; i < tiles.length; i++) {
      if (signal?.aborted) throw new PixError(ErrorCode.Cancelled, "Upscaling was cancelled.");
      const t = tiles[i]!;
      const out = await this.model.run(Upscaler.planar(source, t), t.readWidth, t.readHeight, smooth);
      const expected = 3 * t.readWidth * Upscaler.MODEL_SCALE * t.readHeight * Upscaler.MODEL_SCALE;
      if (out.length !== expected) throw new PixError(ErrorCode.LocalEngineFailed, "The upscaling model returned the wrong size.", { got: out.length, expected });
      const four = Upscaler.crop(out, t);
      await sink.put(factor === 4 ? four : Upscaler.halve(four), t.x * factor, t.y * factor);
      onTile(i + 1, tiles.length);
    }
    return { width: source.width * factor, height: source.height * factor };
  }

  /** The tile's read area as planar RGB in 0..1. */
  static planar(source: RgbaImage, t: Tile): Float32Array {
    const n = t.readWidth * t.readHeight;
    const out = new Float32Array(3 * n);
    for (let y = 0; y < t.readHeight; y++) {
      let s = ((t.readY + y) * source.width + t.readX) * 4;
      for (let x = 0; x < t.readWidth; x++, s += 4) {
        const p = y * t.readWidth + x;
        out[p] = source.data[s]! / 255;
        out[n + p] = source.data[s + 1]! / 255;
        out[2 * n + p] = source.data[s + 2]! / 255;
      }
    }
    return out;
  }

  /** The 4x output without its margin, as opaque RGBA. */
  static crop(out: Float32Array, t: Tile): RgbaImage {
    // Paragraph: where the written part sits inside the 4x read area.
    const S = Upscaler.MODEL_SCALE;
    const outW = t.readWidth * S, n = outW * t.readHeight * S;
    const offX = (t.x - t.readX) * S, offY = (t.y - t.readY) * S;
    const img = Raster.createRgba(t.width * S, t.height * S);

    // Paragraph: copy, clamped to 0..255.
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const p = (offY + y) * outW + offX + x, d = (y * img.width + x) * 4;
        img.data[d] = Math.round(out[p]! * 255);
        img.data[d + 1] = Math.round(out[n + p]! * 255);
        img.data[d + 2] = Math.round(out[2 * n + p]! * 255);
        img.data[d + 3] = 255;
      }
    }
    return img;
  }

  /** Each 2 x 2 block averaged into one pixel. */
  static halve(img: RgbaImage): RgbaImage {
    const out = Raster.createRgba(img.width / 2, img.height / 2);
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const a = (2 * y * img.width + 2 * x) * 4, b = a + img.width * 4, d = (y * out.width + x) * 4;
        for (let c = 0; c < 3; c++) out.data[d + c] = (img.data[a + c]! + img.data[a + 4 + c]! + img.data[b + c]! + img.data[b + 4 + c]! + 2) >> 2;
        out.data[d + 3] = 255;
      }
    }
    return out;
  }
}
