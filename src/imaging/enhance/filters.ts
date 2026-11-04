/**
 * Float image helpers shared by the enhancement filters. All operate on
 * single-channel Float32Array planes of size w*h.
 */

import type { RgbaImage } from "../raster.js";

export class Plane {
  /** Rec.601 luma, 0..255. */
  static luma(img: RgbaImage): Float32Array {
    const out = new Float32Array(img.width * img.height);
    const d = img.data;
    for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    return out;
  }

  /** Mean filter with a (2r+1)^2 box via an integral image. */
  static boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
    if (r <= 0) return Float32Array.from(src);
    const W = w + 1;
    const integral = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += src[y * w + x]!;
        integral[(y + 1) * W + x + 1] = integral[y * W + x + 1]! + row;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        out[y * w + x] = (integral[y1 * W + x1]! - integral[y0 * W + x1]! - integral[y1 * W + x0]! + integral[y0 * W + x0]!) / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }

  /**
   * Very smooth (low-frequency) version of a plane: block-average onto a coarse
   * grid whose longest side is `gridSide`, blur it, and upsample bilinearly.
   */
  static lowFrequency(src: Float32Array, w: number, h: number, gridSide: number): Float32Array {
    // Paragraph: block average onto a coarse grid.
    const gs = gridSide / Math.max(w, h);
    const gw = Math.max(2, Math.round(w * gs)), gh = Math.max(2, Math.round(h * gs));
    const sum = new Float64Array(gw * gh), cnt = new Float64Array(gw * gh);
    for (let y = 0; y < h; y++) {
      const gy = Math.min(gh - 1, Math.floor((y * gh) / h));
      for (let x = 0; x < w; x++) {
        const gx = Math.min(gw - 1, Math.floor((x * gw) / w));
        sum[gy * gw + gx]! += src[y * w + x]!;
        cnt[gy * gw + gx]!++;
      }
    }
    const grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = cnt[i]! > 0 ? sum[i]! / cnt[i]! : 0;

    // Paragraph: smooth the grid, then upsample.
    return Plane.upsample(Plane.boxBlur(Plane.boxBlur(grid, gw, gh, 1), gw, gh, 1), gw, gh, w, h);
  }

  /** Area-average downsample to (dw, dh). */
  static downsample(src: Float32Array, w: number, h: number, dw: number, dh: number): Float32Array {
    const sum = new Float64Array(dw * dh), cnt = new Uint32Array(dw * dh);
    for (let y = 0; y < h; y++) {
      const dy = Math.min(dh - 1, Math.floor((y * dh) / h));
      for (let x = 0; x < w; x++) {
        const d = dy * dw + Math.min(dw - 1, Math.floor((x * dw) / w));
        sum[d]! += src[y * w + x]!;
        cnt[d]!++;
      }
    }
    const out = new Float32Array(dw * dh);
    for (let i = 0; i < out.length; i++) out[i] = cnt[i]! > 0 ? sum[i]! / cnt[i]! : 0;
    return out;
  }

  /** Bilinear upsample (cell-centre aligned). */
  static upsample(src: Float32Array, sw: number, sh: number, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.max(0, Math.min(sh - 1, ((y + 0.5) * sh) / h - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ay = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.max(0, Math.min(sw - 1, ((x + 0.5) * sw) / w - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), ax = fx - x0;
        const top = src[y0 * sw + x0]! * (1 - ax) + src[y0 * sw + x1]! * ax;
        const bot = src[y1 * sw + x0]! * (1 - ax) + src[y1 * sw + x1]! * ax;
        out[y * w + x] = top * (1 - ay) + bot * ay;
      }
    }
    return out;
  }

  /** Separable running max (r>0) or min (r<0) over a (2|r|+1) square. */
  static rankFilter(src: Float32Array, w: number, h: number, r: number, kind: "min" | "max"): Float32Array {
    const pick = kind === "max" ? Math.max : Math.min;
    const pass = (input: Float32Array, horizontal: boolean): Float32Array => {
      const out = new Float32Array(w * h);
      const outer = horizontal ? h : w, inner = horizontal ? w : h;
      const idx = (o: number, i: number) => (horizontal ? o * w + i : i * w + o);
      for (let o = 0; o < outer; o++) {
        for (let i = 0; i < inner; i++) {
          let v = input[idx(o, i)]!;
          for (let k = Math.max(0, i - r); k <= Math.min(inner - 1, i + r); k++) v = pick(v, input[idx(o, k)]!);
          out[idx(o, i)] = v;
        }
      }
      return out;
    };
    return pass(pass(src, true), false);
  }

  static smoothstep(x: number, e0: number, e1: number): number {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }
}
