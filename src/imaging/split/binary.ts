/**
 * Binary-mask morphology and connected components for scan splitting.
 * Masks are GrayImage with values 0 / 1.
 */

import type { Point } from "../geometry.js";
import { Raster, type GrayImage } from "../raster.js";

export interface Component {
  area: number;
  /** Leftmost and rightmost pixel of each row (sufficient for the convex hull). */
  rowExtremes: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class BinaryMorphology {
  /** Sum of mask values in the (2r+1)^2 box around each pixel, via an integral image. */
  private static boxCounts(mask: GrayImage, r: number): Int32Array {
    const { width: w, height: h, data } = mask;
    const W = w + 1;
    const integral = new Int32Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += data[y * w + x]!;
        integral[(y + 1) * W + (x + 1)] = integral[y * W + (x + 1)]! + rowSum;
      }
    }
    const out = new Int32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        out[y * w + x] = integral[y1 * W + x1]! - integral[y0 * W + x1]! - integral[y1 * W + x0]! + integral[y0 * W + x0]!;
      }
    }
    return out;
  }

  static dilate(mask: GrayImage, r: number): GrayImage {
    if (r <= 0) return mask;
    const counts = BinaryMorphology.boxCounts(mask, r);
    const out = Raster.createGray(mask.width, mask.height);
    for (let i = 0; i < counts.length; i++) out.data[i] = counts[i]! > 0 ? 1 : 0;
    return out;
  }

  static erode(mask: GrayImage, r: number): GrayImage {
    if (r <= 0) return mask;
    const { width: w, height: h } = mask;
    const counts = BinaryMorphology.boxCounts(mask, r);
    const out = Raster.createGray(w, h);
    for (let y = 0; y < h; y++) {
      const ny = Math.min(h, y + r + 1) - Math.max(0, y - r);
      for (let x = 0; x < w; x++) {
        const nx = Math.min(w, x + r + 1) - Math.max(0, x - r);
        out.data[y * w + x] = counts[y * w + x] === nx * ny ? 1 : 0;
      }
    }
    return out;
  }

  static close(mask: GrayImage, r: number): GrayImage {
    return BinaryMorphology.erode(BinaryMorphology.dilate(mask, r), r);
  }

  static open(mask: GrayImage, r: number): GrayImage {
    return BinaryMorphology.dilate(BinaryMorphology.erode(mask, r), r);
  }

  /** Marks as foreground every background pixel not 4-connected to the image border. */
  static fillHoles(mask: GrayImage): GrayImage {
    const { width: w, height: h, data } = mask;
    const reached = new Uint8Array(w * h);
    const stack: number[] = [];
    const push = (i: number) => {
      if (data[i] === 0 && reached[i] === 0) {
        reached[i] = 1;
        stack.push(i);
      }
    };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < w * (h - 1)) push(i + w);
    }
    const out = Raster.createGray(w, h);
    for (let i = 0; i < w * h; i++) out.data[i] = data[i] === 1 || reached[i] === 0 ? 1 : 0;
    return out;
  }

  /** 4-connected components of foreground pixels. */
  static components(mask: GrayImage): Component[] {
    const { width: w, height: h, data } = mask;
    const labels = new Int32Array(w * h);
    const result: Component[] = [];
    const stack: number[] = [];

    for (let start = 0; start < w * h; start++) {
      if (data[start] !== 1 || labels[start] !== 0) continue;

      // Paragraph: flood this component, tracking per-row extremes.
      const label = result.length + 1;
      const rowMin = new Map<number, number>();
      const rowMax = new Map<number, number>();
      let area = 0, minX = w, minY = h, maxX = -1, maxY = -1;
      labels[start] = label;
      stack.push(start);
      while (stack.length > 0) {
        const i = stack.pop()!;
        const x = i % w, y = (i - x) / w;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const lo = rowMin.get(y);
        if (lo === undefined || x < lo) rowMin.set(y, x);
        const hi = rowMax.get(y);
        if (hi === undefined || x > hi) rowMax.set(y, x);
        const visit = (j: number) => {
          if (data[j] === 1 && labels[j] === 0) {
            labels[j] = label;
            stack.push(j);
          }
        };
        if (x > 0) visit(i - 1);
        if (x < w - 1) visit(i + 1);
        if (y > 0) visit(i - w);
        if (y < h - 1) visit(i + w);
      }

      // Paragraph: pixel corners (not centers) so the hull encloses whole pixels.
      const rowExtremes: Point[] = [];
      for (const [y, x0] of rowMin) {
        const x1 = rowMax.get(y)!;
        rowExtremes.push({ x: x0, y }, { x: x0, y: y + 1 }, { x: x1 + 1, y }, { x: x1 + 1, y: y + 1 });
      }
      result.push({ area, rowExtremes, minX, minY, maxX, maxY });
    }
    return result;
  }
}
