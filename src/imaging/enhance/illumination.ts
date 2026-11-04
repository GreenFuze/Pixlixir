/**
 * Lighting correction measured from the scene, not guessed from the photo.
 *
 * The surface the prints lie on (album page, table cloth, scanner bed) has
 * roughly uniform reflectance, so its brightness variation across the frame
 * IS the illumination (light fall-off, soft shadows). We model it with the
 * scan's BackgroundModel and divide it out of each print, mapped through the
 * print's own perspective. A photo's real content (a dark floor, a bright sky)
 * is never mistaken for a shadow.
 */

import { Geometry, type Quad } from "../geometry.js";
import { Raster, type RgbaImage } from "../raster.js";
import { BackgroundModel } from "../split/background.js";
import { Plane } from "./filters.js";

export class IlluminationField {
  /** Median colour residual (levels) above which the surface is not a reliable light probe. */
  static readonly MAX_FIT_ERROR = 30;

  private constructor(
    private readonly model: BackgroundModel,
    /** Analysis pixels per source pixel. */
    private readonly scale: number,
    /** Target brightness: the well-lit level of the surface. */
    private readonly reference: number,
  ) {}

  /**
   * Estimates the field from a whole scan, or returns null when the surface
   * is too inconsistent to trust as a light probe.
   */
  static estimate(scan: RgbaImage): IlluminationField | null {
    const { image, scale } = Raster.downscale(scan, 900);
    const band = Math.max(2, Math.round(Math.min(image.width, image.height) * 0.015));
    const model = BackgroundModel.fitBorder(image, band);
    if (model.fitError() > IlluminationField.MAX_FIT_ERROR) return null;
    const samples: number[] = [];
    for (let gy = 0; gy <= 10; gy++) for (let gx = 0; gx <= 10; gx++) samples.push(model.brightnessAt((gx / 10) * (image.width - 1), (gy / 10) * (image.height - 1)));
    samples.sort((a, b) => a - b);
    return new IlluminationField(model, scale, samples[Math.floor(samples.length * 0.85)]!);
  }

  /** Per-pixel gain plane for a print of size (w,h) rectified from `quad` (source pixels). */
  gainPlane(quad: Quad, w: number, h: number, strength: number): Float32Array {
    // Paragraph: sample the field on a coarse grid in print coordinates through the print's homography.
    const H = Geometry.homography([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], quad);
    const G = 24;
    const grid = new Float32Array(G * G);
    for (let gy = 0; gy < G; gy++) {
      for (let gx = 0; gx < G; gx++) {
        const p = Geometry.applyHomography(H, ((gx + 0.5) / G) * w, ((gy + 0.5) / G) * h);
        const b = this.model.brightnessAt(p.x * this.scale, p.y * this.scale);
        grid[gy * G + gx] = Math.max(0.7, Math.min(2.2, Math.pow(this.reference / Math.max(8, b), strength)));
      }
    }
    return Plane.upsample(grid, G, G, w, h);
  }
}

/** Applies a gain plane to an image. */
export class LightingCorrector {
  static apply(img: RgbaImage, gain: Float32Array): RgbaImage {
    const out = Raster.createRgba(img.width, img.height);
    for (let p = 0, i = 0; p < gain.length; p++, i += 4) {
      const g = gain[p]!;
      out.data[i] = img.data[i]! * g;
      out.data[i + 1] = img.data[i + 1]! * g;
      out.data[i + 2] = img.data[i + 2]! * g;
      out.data[i + 3] = img.data[i + 3]!;
    }
    return out;
  }
}
