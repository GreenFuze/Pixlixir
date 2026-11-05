/** Deterministic, feature-rich synthetic scenes and overlapping "camera" views of them (for stitching tests). */

import { Raster, type RgbaImage } from "../../src/imaging/raster.js";

export class SyntheticScene {
  /** Smooth colour gradient + many random discs and boxes: plenty of distinctive corners for SIFT. */
  static textured(width: number, height: number, seed: number): RgbaImage {
    const img = Raster.createRgba(width, height);
    let s = seed >>> 0 || 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);

    // Paragraph: background gradient.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        img.data[i] = 60 + (120 * x) / width;
        img.data[i + 1] = 80 + (100 * y) / height;
        img.data[i + 2] = 140 - (60 * x) / width;
        img.data[i + 3] = 255;
      }
    }

    // Paragraph: random shapes.
    const shapes = Math.round((width * height) / 900);
    for (let k = 0; k < shapes; k++) {
      const cx = rnd() * width, cy = rnd() * height, r = 3 + rnd() * 16;
      const col = [rnd() * 255, rnd() * 255, rnd() * 255];
      const box = rnd() < 0.5;
      for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, Math.ceil(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, Math.ceil(cx + r)); x++) {
          if (!box && (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
          const i = (y * width + x) * 4;
          img.data[i] = col[0]!;
          img.data[i + 1] = col[1]!;
          img.data[i + 2] = col[2]!;
        }
      }
    }
    return img;
  }

  static window(scene: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage {
    const out = Raster.createRgba(w, h);
    for (let y = 0; y < h; y++) {
      const src = ((y0 + y) * scene.width + x0) * 4;
      out.data.set(scene.data.subarray(src, src + w * 4), y * w * 4);
    }
    return out;
  }

  static windows(scene: RgbaImage, xs: number[], y0: number, w: number, h: number): RgbaImage[] {
    return xs.map((x) => SyntheticScene.window(scene, x, y0, w, h));
  }
}
