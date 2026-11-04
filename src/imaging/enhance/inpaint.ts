/**
 * Pull-push inpainting: estimates unknown pixels from known ones through an
 * image pyramid (Gortler et al. style). Produces smooth, seamless fills —
 * suitable for glare spots, dust, scratches and thin creases. Large missing
 * regions get a smooth, detail-free fill (generative reconstruction is a
 * separate, explicitly labelled feature).
 */

import { Raster, type RgbaImage } from "../raster.js";

interface Level {
  w: number;
  h: number;
  /** Premultiplied colour (r,g,b) * weight. */
  p: Float32Array;
  /** Weight in [0,1]. */
  wt: Float32Array;
}

export class PullPushInpainter {
  /**
   * @param known weight per pixel: 1 = trusted, 0 = unknown (values in between blend).
   * @returns a full estimate image; trusted pixels are reproduced, unknown ones filled.
   */
  static fill(img: RgbaImage, known: Float32Array): RgbaImage {
    // Paragraph: level 0 from the image and weights.
    const { width: w, height: h, data } = img;
    const base: Level = { w, h, p: new Float32Array(w * h * 3), wt: new Float32Array(w * h) };
    for (let i = 0; i < w * h; i++) {
      const k = Math.max(0, Math.min(1, known[i]!));
      base.wt[i] = k;
      base.p[i * 3] = data[i * 4]! * k;
      base.p[i * 3 + 1] = data[i * 4 + 1]! * k;
      base.p[i * 3 + 2] = data[i * 4 + 2]! * k;
    }

    // Paragraph: pull — build coarser levels until 1x1.
    const levels: Level[] = [base];
    while (levels[levels.length - 1]!.w > 1 || levels[levels.length - 1]!.h > 1) {
      const f = levels[levels.length - 1]!;
      const cw = Math.max(1, Math.ceil(f.w / 2)), ch = Math.max(1, Math.ceil(f.h / 2));
      const c: Level = { w: cw, h: ch, p: new Float32Array(cw * ch * 3), wt: new Float32Array(cw * ch) };
      for (let y = 0; y < f.h; y++) {
        for (let x = 0; x < f.w; x++) {
          const fi = y * f.w + x, ci = (y >> 1) * cw + (x >> 1);
          c.wt[ci]! += f.wt[fi]!;
          c.p[ci * 3]! += f.p[fi * 3]!;
          c.p[ci * 3 + 1]! += f.p[fi * 3 + 1]!;
          c.p[ci * 3 + 2]! += f.p[fi * 3 + 2]!;
        }
      }
      for (let i = 0; i < cw * ch; i++) {
        const wt = c.wt[i]!;
        if (wt > 1) {
          c.p[i * 3]! /= wt; c.p[i * 3 + 1]! /= wt; c.p[i * 3 + 2]! /= wt;
          c.wt[i] = 1;
        }
      }
      levels.push(c);
    }

    // Paragraph: push — complete each level from the (already complete) coarser one.
    const top = levels[levels.length - 1]!;
    let coarse = PullPushInpainter.colours(top);
    for (let l = levels.length - 2; l >= 0; l--) {
      const lv = levels[l]!;
      const up = PullPushInpainter.upsample3(coarse, levels[l + 1]!.w, levels[l + 1]!.h, lv.w, lv.h);
      const complete = new Float32Array(lv.w * lv.h * 3);
      for (let i = 0; i < lv.w * lv.h; i++) {
        const wt = lv.wt[i]!;
        for (let c = 0; c < 3; c++) complete[i * 3 + c] = lv.p[i * 3 + c]! + (1 - wt) * up[i * 3 + c]!;
      }
      coarse = complete;
    }

    // Paragraph: write out.
    const out = Raster.createRgba(w, h);
    for (let i = 0; i < w * h; i++) {
      out.data[i * 4] = coarse[i * 3]!;
      out.data[i * 4 + 1] = coarse[i * 3 + 1]!;
      out.data[i * 4 + 2] = coarse[i * 3 + 2]!;
      out.data[i * 4 + 3] = data[i * 4 + 3]!;
    }
    return out;
  }

  private static colours(lv: Level): Float32Array {
    const out = new Float32Array(lv.w * lv.h * 3);
    for (let i = 0; i < lv.w * lv.h; i++) {
      const wt = lv.wt[i]!;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = wt > 1e-6 ? lv.p[i * 3 + c]! / wt : 128;
    }
    return out;
  }

  /** Bilinear upsample of an interleaved RGB plane from (sw,sh) to (w,h) with 2x pyramid alignment. */
  private static upsample3(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const fy = Math.max(0, Math.min(sh - 1, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ay = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.max(0, Math.min(sw - 1, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), ax = fx - x0;
        for (let c = 0; c < 3; c++) {
          const a = src[(y0 * sw + x0) * 3 + c]!, b = src[(y0 * sw + x1) * 3 + c]!;
          const d = src[(y1 * sw + x0) * 3 + c]!, e = src[(y1 * sw + x1) * 3 + c]!;
          out[(y * w + x) * 3 + c] = (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay;
        }
      }
    }
    return out;
  }
}
