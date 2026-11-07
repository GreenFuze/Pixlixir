/** Which part of a photo a brushed edit sends, and how its strokes map onto that part. */

import type { BrushStroke } from "../enhance/adjustments.js";
import { StrokeRasterizer } from "../enhance/repair.js";

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class EditRegion {
  /** Smallest side sent, so the service sees enough of the surroundings. */
  static readonly MIN_SIDE = 768;
  /** Surroundings added on each side, as a share of the brushed area. */
  static readonly CONTEXT = 0.6;

  /** The pixels the strokes touch, or null with no strokes. */
  static strokeBounds(strokes: readonly BrushStroke[], width: number, height: number): PixelRect | null {
    if (strokes.length === 0) return null;
    const side = Math.max(width, height);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of strokes) {
      const r = s.radius * side;
      for (const p of s.points) {
        x0 = Math.min(x0, p.u * width - r);
        y0 = Math.min(y0, p.v * height - r);
        x1 = Math.max(x1, p.u * width + r);
        y1 = Math.max(y1, p.v * height + r);
      }
    }
    if (x0 === Infinity) return null;
    return EditRegion.clamp(x0, y0, x1, y1, width, height);
  }

  /** The crop to send: the brushed area with surroundings, inside the photo. */
  static around(bounds: PixelRect, width: number, height: number): PixelRect {
    // Paragraph: add surroundings, at least enough to reach the smallest side.
    const wantW = Math.max(bounds.width * (1 + 2 * EditRegion.CONTEXT), EditRegion.MIN_SIDE);
    const wantH = Math.max(bounds.height * (1 + 2 * EditRegion.CONTEXT), EditRegion.MIN_SIDE);
    const w = Math.min(width, Math.round(wantW)), h = Math.min(height, Math.round(wantH));

    // Paragraph: centred on the brush, moved back inside at the edges.
    const x = Math.max(0, Math.min(width - w, Math.round(bounds.x + bounds.width / 2 - w / 2)));
    const y = Math.max(0, Math.min(height - h, Math.round(bounds.y + bounds.height / 2 - h / 2)));
    return { x, y, width: w, height: h };
  }

  /** The strokes as seen from inside the region. */
  static relative(strokes: readonly BrushStroke[], region: PixelRect, width: number, height: number): BrushStroke[] {
    const scale = Math.max(width, height) / Math.max(region.width, region.height);
    return strokes.map((s) => ({
      ...s,
      radius: s.radius * scale,
      points: s.points.map((p) => ({ u: (p.u * width - region.x) / region.width, v: (p.v * height - region.y) / region.height })),
    }));
  }

  /** A soft mask (0..1) of the strokes at this size; strokes must already be relative to it. */
  static mask(strokes: readonly BrushStroke[], width: number, height: number): Float32Array {
    const painted = strokes.map((s): BrushStroke => ({ ...s, kind: "repair" }));
    return StrokeRasterizer.masks(painted, width, height).repair ?? new Float32Array(width * height);
  }

  private static clamp(x0: number, y0: number, x1: number, y1: number, width: number, height: number): PixelRect {
    const x = Math.max(0, Math.floor(x0)), y = Math.max(0, Math.floor(y0));
    return { x, y, width: Math.max(1, Math.min(width, Math.ceil(x1)) - x), height: Math.max(1, Math.min(height, Math.ceil(y1)) - y) };
  }
}
