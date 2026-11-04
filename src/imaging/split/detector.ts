/**
 * Detects individual printed photographs in a scan / album-page photo.
 *
 * Approach (classical, runs in a worker on a downscaled copy):
 *  1. Estimate the background colour from the image border.
 *  2. Foreground = pixels far from the background colour OR on strong edges
 *     (catches white-bordered prints on white scanner beds via the paper edge).
 *  3. Close gaps, fill holes, remove specks.
 *  4. Connected components -> convex hull -> minimum-area rectangle.
 *
 * Known limitations (surfaced to the user, who can edit every result):
 *  - Prints touching or overlapping each other can merge into one detection.
 *  - Prints whose colour matches the background with no visible edge can be missed.
 *  - Non-rectangular prints (round/oval) are enclosed by their bounding rectangle.
 */

import { Geometry, type Point, type Quad } from "../geometry.js";
import { Raster, type GrayImage, type RgbaImage } from "../raster.js";
import { BinaryMorphology } from "./binary.js";

export interface DetectedPrint {
  /** Corners in source-image pixel coordinates (TL, TR, BR, BL). */
  quad: Quad;
  /** 0..1: how rectangular the detected region is (foreground area / rectangle area). */
  confidence: number;
  /** Fraction of the whole image covered by the rectangle. */
  areaFraction: number;
}

export interface DetectorOptions {
  /** Longest side of the analysis copy. */
  analysisMaxSide: number;
  /** Ignore regions smaller than this fraction of the image. */
  minAreaFraction: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = { analysisMaxSide: 900, minAreaFraction: 0.015 };

export class PrintDetector {
  constructor(private readonly options: DetectorOptions = DEFAULT_DETECTOR_OPTIONS) {}

  detect(source: RgbaImage): DetectedPrint[] {
    Raster.assertRgba(source);

    // Paragraph: analyse a downscaled copy.
    const { image, scale } = Raster.downscale(source, this.options.analysisMaxSide);
    const { width: w, height: h } = image;
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.015));

    // Paragraph: foreground mask from colour distance and edges.
    const bg = PrintDetector.borderMedian(image, band);
    const distance = PrintDetector.colorDistance(image, bg);
    const gradient = PrintDetector.gradientMagnitude(image);
    const tColor = Math.min(80, Math.max(18, PrintDetector.otsu(distance.data)));
    const tEdge = Math.max(40, 2 * PrintDetector.percentile(PrintDetector.borderValues(gradient, band), 0.95));
    const mask = Raster.createGray(w, h);
    for (let i = 0; i < w * h; i++) mask.data[i] = distance.data[i]! > tColor || gradient.data[i]! > tEdge ? 1 : 0;

    // Paragraph: clean up the mask.
    const closeR = Math.max(2, Math.round(Math.max(w, h) * 0.008));
    const cleaned = BinaryMorphology.open(BinaryMorphology.fillHoles(BinaryMorphology.close(mask, closeR)), Math.max(1, Math.round(closeR / 2)));

    // Paragraph: one rectangle per sufficiently large component, mapped back to source pixels.
    const minArea = this.options.minAreaFraction * w * h;
    const prints: DetectedPrint[] = [];
    for (const comp of BinaryMorphology.components(cleaned)) {
      if (comp.area < minArea) continue;
      const hull = Geometry.convexHull(comp.rowExtremes);
      if (hull.length < 3) continue;
      const rect = Geometry.minAreaRect(hull);
      const quad = rect.quad.map((p) => PrintDetector.clampPoint({ x: p.x / scale, y: p.y / scale }, source.width, source.height)) as Quad;
      prints.push({
        quad,
        confidence: Math.max(0, Math.min(1, (comp.area / rect.area - 0.5) / 0.45)),
        areaFraction: Geometry.polygonArea(quad) / (source.width * source.height),
      });
    }
    return PrintDetector.readingOrder(prints);
  }

  // ---- helpers -------------------------------------------------------------

  static borderMedian(img: RgbaImage, band: number): [number, number, number] {
    const channels: [number[], number[], number[]] = [[], [], []];
    const { width: w, height: h, data } = img;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x >= band && x < w - band && y >= band && y < h - band) continue;
        const i = (y * w + x) * 4;
        channels[0].push(data[i]!);
        channels[1].push(data[i + 1]!);
        channels[2].push(data[i + 2]!);
      }
    }
    return [PrintDetector.percentile(channels[0], 0.5), PrintDetector.percentile(channels[1], 0.5), PrintDetector.percentile(channels[2], 0.5)];
  }

  static colorDistance(img: RgbaImage, bg: readonly [number, number, number]): GrayImage {
    const out = Raster.createGray(img.width, img.height);
    for (let p = 0, i = 0; p < out.data.length; p++, i += 4) {
      out.data[p] = Math.max(Math.abs(img.data[i]! - bg[0]), Math.abs(img.data[i + 1]! - bg[1]), Math.abs(img.data[i + 2]! - bg[2]));
    }
    return out;
  }

  /** Sobel magnitude of luma, clamped to 0..255. */
  static gradientMagnitude(img: RgbaImage): GrayImage {
    const { width: w, height: h, data } = img;
    const luma = new Float32Array(w * h);
    for (let p = 0, i = 0; p < luma.length; p++, i += 4) luma[p] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const out = Raster.createGray(w, h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const at = (dx: number, dy: number) => luma[(y + dy) * w + (x + dx)]!;
        const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
        const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
        out.data[y * w + x] = Math.min(255, Math.hypot(gx, gy) / 4);
      }
    }
    return out;
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
