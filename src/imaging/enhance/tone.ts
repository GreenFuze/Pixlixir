/**
 * Tone and colour fixes: faded colour and colour casts, and sharpening.
 * (Lighting correction lives in illumination.ts.)
 */

import { Raster, type RgbaImage } from "../raster.js";
import type { ColorMode } from "./adjustments.js";
import { Plane } from "./filters.js";

/**
 * Restores faded prints. "restore" stretches each channel independently
 * (also neutralises yellowing / colour casts); "preserve" stretches all
 * channels together, keeping the print's original colour character.
 */
export class ColorRestorer {
  static apply(img: RgbaImage, mode: ColorMode, strength: number): RgbaImage {
    const { width: w, height: h, data } = img;

    // Paragraph: robust black/white points from a subsample.
    const step = Math.max(1, Math.floor((w * h) / 250_000));
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let total = 0;
    for (let p = 0; p < w * h; p += step) {
      const i = p * 4;
      const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
      hist[0]![r]!++; hist[1]![g]!++; hist[2]![b]!++;
      hist[3]![Math.round(0.299 * r + 0.587 * g + 0.114 * b)]!++;
      total++;
    }
    const pct = (hh: Uint32Array, q: number) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hh[v]!; if (acc >= q * total) return v; }
      return 255;
    };
    const points = [0, 1, 2].map((c) => {
      const src = mode === "restore" ? hist[c]! : hist[3]!;
      let lo = pct(src, 0.004), hi = pct(src, 0.996);
      if (hi - lo < 48) { const mid = (hi + lo) / 2; lo = mid - 24; hi = mid + 24; } // never amplify noise wildly
      return { lo, hi };
    });

    // Paragraph: stretch, plus a gentle saturation lift when restoring, blended by strength.
    const out = Raster.createRgba(w, h);
    for (let i = 0; i < w * h * 4; i += 4) {
      const st = [0, 1, 2].map((c) => ((data[i + c]! - points[c]!.lo) * 255) / (points[c]!.hi - points[c]!.lo));
      if (mode === "restore") {
        const l = 0.299 * st[0]! + 0.587 * st[1]! + 0.114 * st[2]!;
        for (let c = 0; c < 3; c++) st[c] = l + (st[c]! - l) * 1.12;
      }
      for (let c = 0; c < 3; c++) out.data[i + c] = data[i + c]! + (st[c]! - data[i + c]!) * strength;
      out.data[i + 3] = data[i + 3]!;
    }
    return out;
  }
}

/** Unsharp mask on luma (keeps colours stable). */
export class Sharpener {
  static apply(img: RgbaImage, amount: number): RgbaImage {
    const { width: w, height: h } = img;
    const luma = Plane.luma(img);
    const radius = Math.max(1, Math.round(Math.max(w, h) / 1500));
    const blurred = Plane.boxBlur(luma, w, h, radius);
    const out = Raster.createRgba(w, h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const detail = (luma[p]! - blurred[p]!) * amount * 1.5;
      out.data[i] = img.data[i]! + detail;
      out.data[i + 1] = img.data[i + 1]! + detail;
      out.data[i + 2] = img.data[i + 2]! + detail;
      out.data[i + 3] = img.data[i + 3]!;
    }
    return out;
  }
}
