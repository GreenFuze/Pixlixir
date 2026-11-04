/**
 * Smooth background model for album pages / scanner beds.
 *
 * Fits a quadratic colour surface (per channel) to samples from the image
 * border, with one robust re-fit that drops outliers (e.g. a print touching
 * the edge). This follows gentle lighting gradients and soft shadows across
 * the page, which a single median colour cannot.
 */

import { Geometry } from "../geometry.js";
import { Raster, type GrayImage, type RgbaImage } from "../raster.js";

type Coeffs = [number, number, number, number, number, number];

export class BackgroundModel {
  #fitError = 0;

  private constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly coeffs: [Coeffs, Coeffs, Coeffs],
  ) {}

  /** Median colour residual (levels) of the samples used for the final fit. */
  fitError(): number {
    return this.#fitError;
  }

  /** Mean of the modelled background channels at (x, y). */
  brightnessAt(x: number, y: number): number {
    const c = this.colorAt(x, y);
    return (c[0] + c[1] + c[2]) / 3;
  }

  /** Fits the model to the outer `band` pixels of `img`. */
  static fitBorder(img: RgbaImage, band: number): BackgroundModel {
    // Paragraph: collect a subsample of border pixels.
    const { width: w, height: h, data } = img;
    const step = Math.max(1, Math.round(Math.max(w, h) / 400));
    let samples: { x: number; y: number; rgb: [number, number, number] }[] = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (x >= band && x < w - band && y >= band && y < h - band) continue;
        const i = (y * w + x) * 4;
        samples.push({ x, y, rgb: [data[i]!, data[i + 1]!, data[i + 2]!] });
      }
    }

    // Paragraph: fit, drop outliers, re-fit.
    let model = BackgroundModel.fit(w, h, samples);
    const residuals = samples.map((s) => BackgroundModel.chebyshev(s.rgb, model.colorAt(s.x, s.y)));
    const sorted = [...residuals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const limit = Math.max(12, 3 * median);
    const inliers = samples.filter((_, i) => residuals[i]! <= limit);
    if (inliers.length >= 12) {
      samples = inliers;
      model = BackgroundModel.fit(w, h, samples);
    }
    const finalResiduals = samples.map((s) => BackgroundModel.chebyshev(s.rgb, model.colorAt(s.x, s.y))).sort((a, b) => a - b);
    model.#fitError = finalResiduals[Math.floor(finalResiduals.length / 2)] ?? 0;
    return model;
  }

  colorAt(x: number, y: number): [number, number, number] {
    const b = this.basis(x, y);
    return this.coeffs.map((c) => c[0] * b[0] + c[1] * b[1] + c[2] * b[2] + c[3] * b[3] + c[4] * b[4] + c[5] * b[5]) as [number, number, number];
  }

  /**
   * Per-pixel Chebyshev colour distance from the modelled background,
   * compensated for shading: differences in darker parts of the page are
   * scaled up by (mean background brightness / local background brightness),
   * since a shadow dims print and background alike.
   */
  distanceMap(img: RgbaImage): GrayImage {
    const out = Raster.createGray(img.width, img.height);
    const mean = this.meanBrightness();
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const bg = this.colorAt(x, y);
        const gain = Math.min(4, mean / Math.max(16, (bg[0] + bg[1] + bg[2]) / 3));
        out.data[y * img.width + x] = Math.min(255, gain * BackgroundModel.chebyshev([img.data[i]!, img.data[i + 1]!, img.data[i + 2]!], bg));
      }
    }
    return out;
  }

  /** Mean modelled background brightness over a coarse grid. */
  private meanBrightness(): number {
    let sum = 0, n = 0;
    for (let gy = 0; gy <= 8; gy++) for (let gx = 0; gx <= 8; gx++) {
      const c = this.colorAt((gx / 8) * (this.width - 1), (gy / 8) * (this.height - 1));
      sum += Math.max(16, (c[0] + c[1] + c[2]) / 3);
      n++;
    }
    return sum / n;
  }

  private basis(x: number, y: number): Coeffs {
    const u = (2 * x) / Math.max(1, this.width - 1) - 1;
    const v = (2 * y) / Math.max(1, this.height - 1) - 1;
    return [1, u, v, u * u, u * v, v * v];
  }

  private static fit(w: number, h: number, samples: { x: number; y: number; rgb: [number, number, number] }[]): BackgroundModel {
    const probe = new BackgroundModel(w, h, [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]);
    // Normal equations (6x6) shared by all channels; tiny ridge keeps them well-conditioned.
    const ata = Array.from({ length: 6 }, (_, r) => Array.from({ length: 6 }, (_, c) => (r === c ? 1e-6 : 0)));
    const atb: [number[], number[], number[]] = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
    for (const s of samples) {
      const b = probe.basis(s.x, s.y);
      for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 6; c++) ata[r]![c]! += b[r]! * b[c]!;
        for (let ch = 0; ch < 3; ch++) atb[ch]![r]! += b[r]! * s.rgb[ch]!;
      }
    }
    const coeffs = atb.map((rhs) => Geometry.solveLinear(ata.map((row) => [...row]), rhs) as Coeffs) as [Coeffs, Coeffs, Coeffs];
    return new BackgroundModel(w, h, coeffs);
  }

  private static chebyshev(a: readonly number[], b: readonly number[]): number {
    return Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
  }
}
