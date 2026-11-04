/**
 * Conservative defect repair: automatic dust/scratch detection and manual
 * brush-marked repairs, both filled from surrounding pixels (no invented detail
 * beyond a smooth continuation).
 */

import { Raster, type RgbaImage } from "../raster.js";
import { BinaryMorphology } from "../split/binary.js";
import type { BrushStroke } from "./adjustments.js";
import { Plane } from "./filters.js";
import { PullPushInpainter } from "./inpaint.js";

/** Rasterises normalised brush strokes into soft masks at a given resolution. */
export class StrokeRasterizer {
  static masks(strokes: readonly BrushStroke[], w: number, h: number): Record<BrushStroke["kind"], Float32Array | null> {
    const make = (kind: BrushStroke["kind"]) => (strokes.some((s) => s.kind === kind) ? new Float32Array(w * h) : null);
    const masks: Record<BrushStroke["kind"], Float32Array | null> = { glare: make("glare"), repair: make("repair"), protect: make("protect") };
    const side = Math.max(w, h);
    for (const s of strokes) {
      const target = masks[s.kind]!;
      const r = Math.max(1, s.radius * side);
      const pts = s.points.map((p) => ({ x: p.u * w, y: p.v * h }));
      // Paragraph: stamp soft discs along each segment.
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k]!, b = pts[Math.min(k + 1, pts.length - 1)]!;
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r * 0.3)));
        for (let t = 0; t <= steps; t++) {
          StrokeRasterizer.disc(target, w, h, a.x + ((b.x - a.x) * t) / steps, a.y + ((b.y - a.y) * t) / steps, r);
        }
      }
    }
    return masks;
  }

  private static disc(m: Float32Array, w: number, h: number, cx: number, cy: number, r: number): void {
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const v = 1 - Plane.smoothstep(d, r * 0.8, r + 1);
        if (v > m[y * w + x]!) m[y * w + x] = v;
      }
    }
  }
}

export class DefectRepairer {
  /** Fills the soft mask area from its surroundings. */
  static fillMasked(img: RgbaImage, mask: Float32Array): RgbaImage {
    const known = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) known[i] = 1 - Plane.smoothstep(mask[i]!, 0.02, 0.4);
    const fill = PullPushInpainter.fill(img, known);
    const out = Raster.createRgba(img.width, img.height);
    for (let i = 0, k = 0; i < mask.length; i++, k += 4) {
      const m = mask[i]!;
      for (let c = 0; c < 3; c++) out.data[k + c] = img.data[k + c]! * (1 - m) + fill.data[k + c]! * m;
      out.data[k + 3] = img.data[k + 3]!;
    }
    return out;
  }

  /**
   * Dust & scratch mask: small or thin structures much brighter or darker than
   * their neighbourhood (morphological top-hats), excluding larger features.
   */
  static detectDust(img: RgbaImage, sensitivity: number, protect: Float32Array | null): Float32Array {
    const { width: w, height: h } = img;
    const n = w * h;

    // Paragraph: bright and dark top-hats at a radius matched to dust size.
    const luma = Plane.luma(img);
    const r = Math.max(2, Math.round(Math.max(w, h) / 900));
    const opened = Plane.rankFilter(Plane.rankFilter(luma, w, h, r, "min"), w, h, r, "max");
    const closed = Plane.rankFilter(Plane.rankFilter(luma, w, h, r, "max"), w, h, r, "min");
    const threshold = 42 - 26 * sensitivity;
    const bin = Raster.createGray(w, h);
    for (let p = 0; p < n; p++) bin.data[p] = luma[p]! - opened[p]! > threshold || closed[p]! - luma[p]! > threshold ? 1 : 0;

    // Paragraph: keep specks and thin lines; drop larger blobs (real image detail).
    const { components, labels } = BinaryMorphology.components(bin);
    const maxSpeck = (2 * r + 1) ** 2 * 4;
    const keep = new Set<number>();
    for (const c of components) {
      const extent = Math.max(c.maxX - c.minX + 1, c.maxY - c.minY + 1);
      const thickness = c.area / extent;
      if (c.area <= maxSpeck || thickness <= r * 1.2) keep.add(c.label);
    }
    const mask = new Float32Array(n);
    for (let p = 0; p < n; p++) mask[p] = keep.has(labels[p]!) ? 1 : 0;

    // Paragraph: grow slightly so halos are covered; honour protected areas.
    const grown = Plane.rankFilter(mask, w, h, 1, "max");
    if (protect) for (let p = 0; p < n; p++) grown[p] = grown[p]! * (1 - protect[p]!);
    return grown;
  }
}
