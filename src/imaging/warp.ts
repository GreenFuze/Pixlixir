/**
 * Perspective rectification: crops a quadrilateral region of a source image
 * into an upright rectangle using a homography and bilinear sampling.
 */

import { ErrorCode, PixError } from "../shared/errors.js";
import { Geometry, type Quad } from "./geometry.js";
import { Raster, type RgbaImage } from "./raster.js";

export class PerspectiveWarper {
  /** Largest output side we will produce, to bound memory. */
  static readonly MAX_OUTPUT_SIDE = 12000;

  static rectify(src: RgbaImage, quad: Quad): RgbaImage {
    Raster.assertRgba(src);

    // Paragraph: output size and mapping from output pixels to source coordinates.
    const { width, height } = Geometry.rectifiedSize(quad);
    if (width > PerspectiveWarper.MAX_OUTPUT_SIDE || height > PerspectiveWarper.MAX_OUTPUT_SIDE) {
      throw new PixError(ErrorCode.InvalidGeometry, "Selected region is too large to rectify", { width, height });
    }
    const H = Geometry.homography(
      [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }],
      quad,
    );

    // Paragraph: bilinear sampling at pixel centres; outside pixels become transparent black.
    const out = Raster.createRgba(width, height);
    const sw = src.width, sh = src.height, sd = src.data, od = out.data;
    for (let v = 0; v < height; v++) {
      for (let u = 0; u < width; u++) {
        const p = Geometry.applyHomography(H, u + 0.5, v + 0.5);
        const fx = p.x - 0.5, fy = p.y - 0.5;
        const o = (v * width + u) * 4;
        if (fx < -0.5 || fy < -0.5 || fx > sw - 0.5 || fy > sh - 0.5) continue;
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
        const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
        const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        for (let c = 0; c < 4; c++) {
          const top = sd[i00 + c]! + (sd[i10 + c]! - sd[i00 + c]!) * ax;
          const bottom = sd[i01 + c]! + (sd[i11 + c]! - sd[i01 + c]!) * ax;
          od[o + c] = top + (bottom - top) * ay;
        }
      }
    }
    return out;
  }
}
