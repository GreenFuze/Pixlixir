/**
 * Detects individual printed photographs in a scan / album-page photo.
 *
 * Approach (classical, runs in a worker on a downscaled copy):
 *  1. Model the background (with gentle shading) from the image border.
 *  2. Foreground = pixels far from the background colour OR on strong edges
 *     (catches white-bordered prints on white scanner beds via the paper edge).
 *  3. Close gaps, fill holes, remove specks — at several scales. A coarse
 *     region is split when a finer scale separates it into parts; every
 *     coarse pixel is then assigned to its nearest part and the split is kept
 *     only if the resulting groups are clearly more rectangular.
 *  4. Each region -> convex hull -> tightest enclosing quad
 *     (perspective-following) or minimum-area rectangle.
 *  5. Discard regions spanning the frame edge-to-edge (table, floor).
 *  6. On textured backgrounds, snap each quad side onto the print's real
 *     straight edge (EdgeSnapper).
 *
 * Known limitations (surfaced to the user, who can edit every result):
 *  - Prints that overlap each other can still merge into one detection.
 *  - A single print filling the whole frame is not detected (it spans the frame).
 *  - Prints whose colour matches the background with no visible edge can be missed.
 *  - Non-rectangular prints (round/oval) are enclosed by their bounding quad.
 */

import { Geometry, type Point, type Quad } from "../geometry.js";
import { Raster, type GrayImage, type RgbaImage } from "../raster.js";
import { BackgroundModel } from "./background.js";
import { BinaryMorphology } from "./binary.js";
import { EdgeSnapper } from "./edge-snap.js";

export interface DetectedPrint {
  /** Corners in source-image pixel coordinates (TL, TR, BR, BL). */
  quad: Quad;
  /** 0..1: how rectangular the detected region is (foreground area / quad area). */
  confidence: number;
  /** Fraction of the whole image covered by the quad. */
  areaFraction: number;
}

export interface DetectorOptions {
  /** Longest side of the analysis copy. */
  analysisMaxSide: number;
  /** Ignore regions smaller than this fraction of the image. */
  minAreaFraction: number;
}

/** Optional sink for intermediate masks (developer tooling only). */
export type DetectorDebugSink = (stage: string, image: GrayImage) => void;

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = { analysisMaxSide: 900, minAreaFraction: 0.015 };

/** A set of analysis-image pixels with its enclosing quad. */
class PixelRegion {
  private constructor(
    readonly pixels: Int32Array,
    readonly quad: Quad,
    /** Pixel count / quad area. */
    readonly rectangularity: number,
    readonly bbox: { minX: number; minY: number; maxX: number; maxY: number },
  ) {}

  static fromPixels(pixels: Int32Array, width: number): PixelRegion | null {
    // Paragraph: per-row extremes (pixel corners) suffice for the convex hull.
    const rowMin = new Map<number, number>(), rowMax = new Map<number, number>();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pixels) {
      const x = p % width, y = (p - x) / width;
      const lo = rowMin.get(y);
      if (lo === undefined || x < lo) rowMin.set(y, x);
      const hi = rowMax.get(y);
      if (hi === undefined || x > hi) rowMax.set(y, x);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pts: Point[] = [];
    for (const [y, x0] of rowMin) {
      const x1 = rowMax.get(y)!;
      pts.push({ x: x0, y }, { x: x0, y: y + 1 }, { x: x1 + 1, y }, { x: x1 + 1, y: y + 1 });
    }

    // Paragraph: tightest of perspective quad and min-area rectangle.
    const hull = Geometry.convexHull(pts);
    if (hull.length < 3) return null;
    const rect = Geometry.minAreaRect(hull);
    const persp = Geometry.enclosingQuad(hull);
    const perspArea = persp ? Geometry.polygonArea(persp) : Infinity;
    const best = persp && perspArea < rect.area ? { quad: persp, area: perspArea } : rect;
    return new PixelRegion(pixels, best.quad, pixels.length / best.area, { minX, minY, maxX, maxY });
  }

  /** Distance from a point to the region's quad (0 inside). */
  distanceTo(x: number, y: number): number {
    const q = this.quad;
    let inside = true, best = Infinity;
    for (let i = 0; i < 4; i++) {
      const a = q[i]!, b = q[(i + 1) % 4]!;
      if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) inside = false;
      const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / len2));
      best = Math.min(best, Math.hypot(x - (a.x + t * (b.x - a.x)), y - (a.y + t * (b.y - a.y))));
    }
    return inside ? 0 : best;
  }
}

export class PrintDetector {
  constructor(private readonly options: DetectorOptions = DEFAULT_DETECTOR_OPTIONS) {}

  detect(source: RgbaImage, debug?: DetectorDebugSink): DetectedPrint[] {
    Raster.assertRgba(source);

    // Paragraph: analyse a downscaled copy.
    const { image, scale } = Raster.downscale(source, this.options.analysisMaxSide);
    const { width: w, height: h } = image;
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.015));

    // Paragraph: foreground mask from distance to a shading-aware background model, and edges.
    const distance = BackgroundModel.fitBorder(image, band).distanceMap(image);
    const sobel = PrintDetector.sobel(image);
    const gradient = sobel.magnitude;
    const tColor = Math.min(80, Math.max(18, PrintDetector.otsu(distance.data)));
    const tEdge = Math.max(40, 2 * PrintDetector.percentile(PrintDetector.borderValues(gradient, band), 0.95));
    const mask = Raster.createGray(w, h);
    for (let i = 0; i < w * h; i++) mask.data[i] = distance.data[i]! > tColor || gradient.data[i]! > tEdge ? 1 : 0;
    debug?.("distance", distance);
    debug?.("gradient", gradient);
    debug?.("mask", mask);

    // Paragraph: segment at several gap-closing scales (coarse -> fine).
    const baseR = Math.max(2, Math.round(Math.max(w, h) * 0.008));
    const minArea = this.options.minAreaFraction * w * h;
    const levels = [1, 0.6, 0.35, 0.2].map((f, i) => {
      const r = Math.max(1, Math.round(baseR * f));
      const cleaned = BinaryMorphology.open(BinaryMorphology.fillHoles(BinaryMorphology.close(mask, r)), Math.max(1, Math.round(r / 2)));
      debug?.(`level-${i}`, cleaned);
      return PrintDetector.regionsOf(cleaned, minArea);
    });

    // Paragraph: refine coarse regions (prints lying close together merge at coarse scales),
    // then drop scenery that spans the frame.
    const regions = levels[0]!
      .flatMap((r) => PrintDetector.refine(r, 0, levels, w, minArea))
      .filter((r) => !PrintDetector.spansFrame(r, w, h));

    // Paragraph: on textured backgrounds, snap each side onto the print's real edge; map back to source pixels.
    const textured = PrintDetector.percentile(PrintDetector.borderValues(gradient, band), 0.5) >= PrintDetector.TEXTURED_BACKGROUND;
    debug?.(textured ? "background-textured" : "background-smooth", Raster.createGray(1, 1));
    const snapper = textured ? new EdgeSnapper(PrintDetector.colorAndTextureDistance(distance, gradient, band)) : null;
    const coarseQuads = regions.map((r) => (snapper ? snapper.snap(r.quad) : r.quad).map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad);
    const fineQuads = textured ? this.refineAtHigherResolution(source, coarseQuads) : coarseQuads;
    const prints: DetectedPrint[] = regions.map((r, idx) => {
      const quad = fineQuads[idx]!.map((p) => PrintDetector.clampPoint(p, source.width, source.height)) as Quad;
      return { quad, confidence: Math.max(0, Math.min(1, (r.rectangularity - 0.5) / 0.45)), areaFraction: Geometry.polygonArea(quad) / (source.width * source.height) };
    });
    return PrintDetector.readingOrder(prints);
  }

  /** Re-snaps quads (source coordinates) on a ~2.2x finer analysis copy with a small search window. */
  private refineAtHigherResolution(source: RgbaImage, quads: readonly Quad[]): Quad[] {
    const fineSide = Math.round(this.options.analysisMaxSide * 2.2);
    if (Math.max(source.width, source.height) <= this.options.analysisMaxSide * 1.2) return [...quads];
    const { image, scale } = Raster.downscale(source, fineSide);
    const band = Math.max(2, Math.round(Math.min(image.width, image.height) * 0.015));
    const distance = BackgroundModel.fitBorder(image, band).distanceMap(image);
    const map = PrintDetector.colorAndTextureDistance(distance, PrintDetector.sobel(image).magnitude, band);
    const snapper = new EdgeSnapper(map, 0.025);
    return quads.map((q) => snapper.snap(q.map((p) => ({ x: p.x * scale, y: p.y * scale })) as Quad).map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad);
  }

  /** Median border gradient (Sobel/4 units) above which the background counts as textured. */
  static readonly TEXTURED_BACKGROUND = 4;

  // ---- segmentation helpers ------------------------------------------------------

  /** Large connected components of a mask as pixel regions. */
  static regionsOf(mask: GrayImage, minArea: number): PixelRegion[] {
    const { components, labels } = BinaryMorphology.components(mask);
    const big = components.filter((c) => c.area >= minArea);
    const buckets = new Map<number, { pixels: Int32Array; n: number }>(big.map((c) => [c.label, { pixels: new Int32Array(c.area), n: 0 }]));
    for (let i = 0; i < labels.length; i++) {
      const b = buckets.get(labels[i]!);
      if (b) b.pixels[b.n++] = i;
    }
    return [...buckets.values()].map((b) => PixelRegion.fromPixels(b.pixels, mask.width)).filter((r): r is PixelRegion => r !== null);
  }

  /**
   * Splits a region when a finer level separates it into ≥2 parts AND the
   * region's own pixels, grouped by nearest part, are clearly more rectangular.
   * Grouping all coarse pixels (not just the fine parts) means a print that is
   * fragmented at the fine scale is never truncated.
   */
  static refine(region: PixelRegion, level: number, levels: readonly PixelRegion[][], width: number, minArea: number): PixelRegion[] {
    const member = new Set<number>(region.pixels);
    for (let k = level + 1; k < levels.length; k++) {
      // Paragraph: fine parts inside this region.
      const parts = levels[k]!.filter((p) => member.has(p.pixels[0]!));
      if (parts.length < 2) continue;

      // Paragraph: group the region's pixels by nearest part.
      const groups = parts.map(() => [] as number[]);
      for (const px of region.pixels) {
        const x = px % width, y = (px - x) / width;
        let best = 0, bestD = Infinity;
        parts.forEach((p, i) => {
          const d = p.distanceTo(x + 0.5, y + 0.5);
          if (d < bestD) { bestD = d; best = i; }
        });
        groups[best]!.push(px);
      }
      const split = groups.filter((g) => g.length >= minArea).map((g) => PixelRegion.fromPixels(Int32Array.from(g), width)).filter((r): r is PixelRegion => r !== null);
      if (split.length < 2) continue;

      // Paragraph: keep the split only if it is clearly better.
      const total = split.reduce((s, r) => s + r.pixels.length, 0);
      const score = split.reduce((s, r) => s + r.pixels.length * r.rectangularity, 0) / total;
      if (score > region.rectangularity + 0.03) return split.flatMap((r) => PrintDetector.refine(r, k, levels, width, minArea));
    }
    return [region];
  }

  /** Regions touching two or more image edges are scenery (table, floor), not prints. */
  static spansFrame(r: PixelRegion, w: number, h: number): boolean {
    const b = r.bbox;
    return [b.minX <= 1, b.minY <= 1, b.maxX >= w - 2, b.maxY >= h - 2].filter(Boolean).length >= 2;
  }

  // ---- pixel helpers -------------------------------------------------------------

  /**
   * Colour distance plus texture distance: |local gradient energy − background's typical energy|.
   * Separates a pale, smooth print area from a similarly coloured but textured cloth.
   */
  static colorAndTextureDistance(distance: GrayImage, gradient: GrayImage, band: number): GrayImage {
    const { width: w, height: h } = gradient;
    const energy = PrintDetector.boxBlur(gradient, 2);
    const bgEnergy = PrintDetector.percentile(PrintDetector.borderValues(energy, band), 0.5);
    const out = Raster.createGray(w, h);
    for (let i = 0; i < w * h; i++) out.data[i] = Math.min(255, distance.data[i]! + Math.min(100, 6 * Math.abs(energy.data[i]! - bgEnergy)));
    return out;
  }

  /** Mean filter with a (2r+1)^2 box, via an integral image. */
  static boxBlur(img: GrayImage, r: number): GrayImage {
    const { width: w, height: h, data } = img;
    const W = w + 1;
    const integral = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += data[y * w + x]!;
        integral[(y + 1) * W + x + 1] = integral[y * W + x + 1]! + row;
      }
    }
    const out = Raster.createGray(w, h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const sum = integral[y1 * W + x1]! - integral[y0 * W + x1]! - integral[y1 * W + x0]! + integral[y0 * W + x0]!;
        out.data[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return out;
  }

  /** Sobel gradients of luma (scaled by 1/4) and their magnitude clamped to 0..255. */
  static sobel(img: RgbaImage): { gx: Float32Array; gy: Float32Array; magnitude: GrayImage } {
    const { width: w, height: h, data } = img;
    const luma = new Float32Array(w * h);
    for (let p = 0, i = 0; p < luma.length; p++, i += 4) luma[p] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    const magnitude = Raster.createGray(w, h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const at = (dx: number, dy: number) => luma[(y + dy) * w + (x + dx)]!;
        const i = y * w + x;
        gx[i] = (at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)) / 4;
        gy[i] = (at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)) / 4;
        magnitude.data[i] = Math.min(255, Math.hypot(gx[i]!, gy[i]!));
      }
    }
    return { gx, gy, magnitude };
  }

  static borderValues(img: GrayImage, band: number): number[] {
    const values: number[] = [];
    const { width: w, height: h } = img;
    // Skip the outermost pixel row/column: Sobel leaves them at 0.
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (x >= band && x < w - band && y >= band && y < h - band) continue;
        values.push(img.data[y * w + x]!);
      }
    }
    return values;
  }

  static percentile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  }

  /** Otsu threshold over 0..255 values. */
  static otsu(values: Uint8Array): number {
    const hist = new Float64Array(256);
    for (const v of values) hist[v]!++;
    const total = values.length;
    let sumAll = 0;
    for (let t = 0; t < 256; t++) sumAll += t * hist[t]!;
    let sumB = 0, wB = 0, best = 0, bestT = 0;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]!;
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t]!;
      const mB = sumB / wB, mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; bestT = t; }
    }
    return bestT;
  }

  static clampPoint(p: Point, w: number, h: number): Point {
    return { x: Math.max(0, Math.min(w, p.x)), y: Math.max(0, Math.min(h, p.y)) };
  }

  /** Sort top-to-bottom in rows, then left-to-right. */
  static readingOrder(prints: DetectedPrint[]): DetectedPrint[] {
    const center = (q: Quad) => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 });
    const heights = prints.map((p) => Geometry.rectifiedSize(p.quad).height).sort((a, b) => a - b);
    const rowH = Math.max(1, (heights[Math.floor(heights.length / 2)] ?? 1) / 2);
    return [...prints].sort((a, b) => {
      const ca = center(a.quad), cb = center(b.quad);
      const ra = Math.floor(ca.y / rowH), rb = Math.floor(cb.y / rowH);
      return ra - rb || ca.x - cb.x;
    });
  }
}
