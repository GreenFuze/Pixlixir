/**
 * Marks the area to edit on the picture sent, finds where a returned picture lines up with the
 * photo, and pastes only the brushed area back. AI services redraw the whole picture and may change
 * its size or framing, so the part outside the brush is what tells us where the result belongs.
 */

import { ErrorCode, PixError } from "../../shared/errors.js";
import { Raster, type RgbaImage } from "../raster.js";

/** Where the result goes, as fractions of the region. */
export interface FitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FitEstimate {
  rect: FitRect;
  /** Mean brightness difference (0..255) outside the brush. */
  error: number;
  /** How well the patterns agree outside the brush (-1..1), whatever the overall tone. */
  agreement: number;
  linesUp: boolean;
}

export class EditMarking {
  static readonly COLOR = [255, 0, 255] as const;
  static readonly STRENGTH = 0.6;

  /** A copy of the picture with the area to edit tinted. */
  static mark(img: RgbaImage, mask: Float32Array): RgbaImage {
    Raster.assertRgba(img);
    const out = Raster.createRgba(img.width, img.height);
    for (let i = 0, k = 0; i < mask.length; i++, k += 4) {
      const a = mask[i]! * EditMarking.STRENGTH;
      for (let c = 0; c < 3; c++) out.data[k + c] = img.data[k + c]! * (1 - a) + EditMarking.COLOR[c]! * a;
      out.data[k + 3] = img.data[k + 3]!;
    }
    return out;
  }
}

export class PasteBack {
  /** `base` with `top` shown through the mask. Where `top` is transparent, `base` stays. */
  static apply(base: RgbaImage, top: RgbaImage, mask: Float32Array): RgbaImage {
    Raster.assertRgba(base);
    Raster.assertRgba(top);
    if (top.width !== base.width || top.height !== base.height || mask.length !== base.width * base.height) {
      throw new PixError(ErrorCode.InvalidImage, "The result and the photo area differ in size", { base: [base.width, base.height], top: [top.width, top.height], mask: mask.length });
    }
    const out = Raster.createRgba(base.width, base.height);
    for (let i = 0, k = 0; i < mask.length; i++, k += 4) {
      const a = mask[i]! * (top.data[k + 3]! / 255);
      for (let c = 0; c < 3; c++) out.data[k + c] = base.data[k + c]! * (1 - a) + top.data[k + c]! * a;
      out.data[k + 3] = base.data[k + 3]!;
    }
    return out;
  }
}

export class ResultFit {
  /**
   * A result lines up when it is nearly the same picture, or when its patterns agree though the tone
   * changed. Brightness alone cannot tell: a flat grey result is close to many photos. These limits
   * are a judgement from synthetic tests, not measured on real results.
   */
  static readonly CLOSE_ERROR = 12;
  static readonly MIN_AGREEMENT = 0.6;
  /** A placement must cover this share of the pixels outside the brush to count. */
  private static readonly MIN_COVERAGE = 0.6;

  /** Finds the placement of `result` that best matches `region` outside the brush. Pass small images. */
  static estimate(region: RgbaImage, result: RgbaImage, brush: Float32Array): FitEstimate {
    Raster.assertRgba(region);
    Raster.assertRgba(result);
    const a = ResultFit.gray(region), b = ResultFit.gray(result);

    // Paragraph: the result may be stretched to our shape, or cropped or padded to its own.
    let best = { rect: { x: 0, y: 0, width: 1, height: 1 }, error: Infinity };
    for (const start of ResultFit.starts(region, result)) {
      let top = ResultFit.search(a, b, region, result, brush, start, 3, 0.03, 0.02);
      top = ResultFit.search(a, b, region, result, brush, top.rect, 2, 0.01, 0.007);
      top = ResultFit.search(a, b, region, result, brush, top.rect, 2, 0.004, 0.003);
      if (top.error < best.error) best = top;
    }
    if (best.error === Infinity) {
      throw new PixError(ErrorCode.EditResultInvalid, "The result could not be compared with the photo", { region: [region.width, region.height], result: [result.width, result.height] });
    }
    const agreement = ResultFit.agreement(a, b, region, result, brush, best.rect);
    return { ...best, agreement, linesUp: best.error <= ResultFit.CLOSE_ERROR || agreement >= ResultFit.MIN_AGREEMENT };
  }

  private static starts(region: RgbaImage, result: RgbaImage): FitRect[] {
    const ar = result.width / result.height / (region.width / region.height);
    const stretched = { x: 0, y: 0, width: 1, height: 1 };
    if (Math.abs(ar - 1) < 0.01) return [stretched];
    const fitWidth = { x: 0, y: (1 - 1 / ar) / 2, width: 1, height: 1 / ar };
    const fitHeight = { x: (1 - ar) / 2, y: 0, width: ar, height: 1 };
    return [stretched, fitWidth, fitHeight];
  }

  /** Tries sizes and offsets around `start`, keeping its centre. */
  private static search(a: Float32Array, b: Float32Array, region: RgbaImage, result: RgbaImage, brush: Float32Array, start: FitRect, reach: number, sizeStep: number, moveStep: number): { rect: FitRect; error: number } {
    let best = { rect: start, error: Infinity };
    for (let sw = -reach; sw <= reach; sw++) {
      const width = start.width * (1 + sw * sizeStep);
      for (let sh = -reach; sh <= reach; sh++) {
        const height = start.height * (1 + sh * sizeStep);
        for (let mx = -reach; mx <= reach; mx++) {
          const x = start.x + (start.width - width) / 2 + mx * moveStep;
          for (let my = -reach; my <= reach; my++) {
            const rect = { x, y: start.y + (start.height - height) / 2 + my * moveStep, width, height };
            const error = ResultFit.score(a, b, region, result, brush, rect);
            if (error < best.error) best = { rect, error };
          }
        }
      }
    }
    return best;
  }

  private static score(a: Float32Array, b: Float32Array, region: RgbaImage, result: RgbaImage, brush: Float32Array, rect: FitRect): number {
    let sum = 0, used = 0, usable = 0;
    for (let y = 0, i = 0; y < region.height; y++) {
      const by = Math.floor((((y + 0.5) / region.height - rect.y) / rect.height) * result.height);
      for (let x = 0; x < region.width; x++, i++) {
        if (brush[i]! > 0.02) continue;
        usable++;
        const bx = Math.floor((((x + 0.5) / region.width - rect.x) / rect.width) * result.width);
        if (bx < 0 || by < 0 || bx >= result.width || by >= result.height) continue;
        sum += Math.abs(a[i]! - b[by * result.width + bx]!);
        used++;
      }
    }
    return usable === 0 || used < usable * ResultFit.MIN_COVERAGE ? Infinity : sum / used;
  }

  /** Correlation of the two pictures at this placement, outside the brush. */
  private static agreement(a: Float32Array, b: Float32Array, region: RgbaImage, result: RgbaImage, brush: Float32Array, rect: FitRect): number {
    // Paragraph: the pairs of pixels that overlap.
    const xs: number[] = [], ys: number[] = [];
    for (let y = 0, i = 0; y < region.height; y++) {
      const by = Math.floor((((y + 0.5) / region.height - rect.y) / rect.height) * result.height);
      for (let x = 0; x < region.width; x++, i++) {
        const bx = Math.floor((((x + 0.5) / region.width - rect.x) / rect.width) * result.width);
        if (brush[i]! > 0.02 || bx < 0 || by < 0 || bx >= result.width || by >= result.height) continue;
        xs.push(a[i]!);
        ys.push(b[by * result.width + bx]!);
      }
    }

    // Paragraph: Pearson correlation; a flat picture agrees with nothing.
    const mean = (v: number[]) => v.reduce((s, n) => s + n, 0) / v.length;
    const mx = mean(xs), my = mean(ys);
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < xs.length; i++) {
      const dx = xs[i]! - mx, dy = ys[i]! - my;
      xy += dx * dy; xx += dx * dx; yy += dy * dy;
    }
    return xx === 0 || yy === 0 ? 0 : xy / Math.sqrt(xx * yy);
  }

  private static gray(img: RgbaImage): Float32Array {
    const out = new Float32Array(img.width * img.height);
    for (let i = 0, k = 0; i < out.length; i++, k += 4) out[i] = 0.299 * img.data[k]! + 0.587 * img.data[k + 1]! + 0.114 * img.data[k + 2]!;
    return out;
  }
}
