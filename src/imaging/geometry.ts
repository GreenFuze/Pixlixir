/**
 * 2D geometry used by scan splitting: convex hull, minimum-area rectangle,
 * corner ordering and perspective homographies.
 */

import { ErrorCode, PixError } from "../shared/errors.js";

export interface Point {
  x: number;
  y: number;
}

/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

/** Row-major 3x3 homography. */
export type Homography = [number, number, number, number, number, number, number, number, number];

export class Geometry {
  /** Andrew's monotone chain. Returns hull in counter-clockwise order without duplicates. */
  static convexHull(points: readonly Point[]): Point[] {
    if (points.length < 3) return points.map((p) => ({ ...p }));
    const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

    const lower: Point[] = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper: Point[] = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i]!;
      while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  /**
   * Minimum-area enclosing rectangle of a convex hull (rotating calipers over
   * hull edge directions). The result always contains every hull point, so a
   * detected print is never truncated by this step.
   */
  static minAreaRect(hull: readonly Point[]): { quad: Quad; area: number } {
    if (hull.length < 3) {
      throw new PixError(ErrorCode.InvalidGeometry, "minAreaRect needs at least 3 hull points", { count: hull.length });
    }
    let best: { area: number; quad: Quad } | null = null;
    for (let i = 0; i < hull.length; i++) {
      // Paragraph: project all points onto the edge direction and its normal.
      const a = hull[i]!;
      const b = hull[(i + 1) % hull.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const ux = (b.x - a.x) / len;
      const uy = (b.y - a.y) / len;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of hull) {
        const u = p.x * ux + p.y * uy;
        const v = -p.x * uy + p.y * ux;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }

      // Paragraph: keep the smallest rectangle, mapped back to image space.
      const area = (maxU - minU) * (maxV - minV);
      if (!best || area < best.area) {
        const toXY = (u: number, v: number): Point => ({ x: u * ux - v * uy, y: u * uy + v * ux });
        best = { area, quad: Geometry.orderCorners([toXY(minU, minV), toXY(maxU, minV), toXY(maxU, maxV), toXY(minU, maxV)]) };
      }
    }
    if (!best) throw new PixError(ErrorCode.InvalidGeometry, "Degenerate hull (all points coincide)");
    return best;
  }

  /**
   * Small enclosing quadrilateral of a convex hull: greedily removes the hull
   * edge whose removal (extending both neighbouring edges to their
   * intersection) adds the least area, until 4 vertices remain. Unlike a
   * rectangle this follows perspective-distorted prints, and like the
   * rectangle it always contains the whole hull. Returns null if the hull
   * cannot be reduced (e.g. parallel neighbouring edges everywhere).
   */
  static enclosingQuad(hull: readonly Point[]): Quad | null {
    if (hull.length < 4) return null;
    const poly = hull.map((p) => ({ ...p }));
    while (poly.length > 4) {
      // Paragraph: find the cheapest edge to eliminate.
      const n = poly.length;
      let best = -1, bestArea = Infinity, bestPoint: Point | null = null;
      for (let i = 0; i < n; i++) {
        const a = poly[(i - 1 + n) % n]!, b = poly[i]!, c = poly[(i + 1) % n]!, d = poly[(i + 2) % n]!;
        const x = Geometry.lineIntersection(a, b, d, c);
        if (!x) continue;
        // The intersection must lie forward of b (along a→b) and forward of c (along d→c).
        if ((x.x - b.x) * (b.x - a.x) + (x.y - b.y) * (b.y - a.y) < -1e-9) continue;
        if ((x.x - c.x) * (c.x - d.x) + (x.y - c.y) * (c.y - d.y) < -1e-9) continue;
        const added = Math.abs((c.x - b.x) * (x.y - b.y) - (x.x - b.x) * (c.y - b.y)) / 2;
        if (added < bestArea) { bestArea = added; best = i; bestPoint = x; }
      }
      if (best < 0 || !bestPoint) return null;

      // Paragraph: replace edge (best, best+1) with the intersection point.
      const next = (best + 1) % n;
      poly[best] = bestPoint;
      poly.splice(next, 1);
    }
    return Geometry.orderCorners(poly);
  }

  /** Intersection of infinite lines (p1,p2) and (p3,p4), or null when parallel. */
  static lineIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
    const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if (Math.abs(d) < 1e-12) return null;
    const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
    return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
  }

  /** Orders 4 points clockwise (screen coordinates) starting at the top-left-most corner (min x+y). */
  static orderCorners(pts: readonly Point[]): Quad {
    if (pts.length !== 4) throw new PixError(ErrorCode.InvalidGeometry, "orderCorners needs exactly 4 points", { count: pts.length });
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const clockwise = [...pts].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
    let start = 0;
    clockwise.forEach((p, i) => {
      if (p.x + p.y < clockwise[start]!.x + clockwise[start]!.y) start = i;
    });
    return [0, 1, 2, 3].map((k) => ({ ...clockwise[(start + k) % 4]! })) as Quad;
  }

  /** Output size for rectifying a quad: max opposite-edge lengths. */
  static rectifiedSize(q: Quad): { width: number; height: number } {
    const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
    return {
      width: Math.max(1, Math.round(Math.max(d(q[0], q[1]), d(q[3], q[2])))),
      height: Math.max(1, Math.round(Math.max(d(q[0], q[3]), d(q[1], q[2])))),
    };
  }

  static polygonArea(pts: readonly Point[]): number {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  /** Homography H with H·src[i] ≈ dst[i] for 4 correspondences (DLT, h33 = 1). */
  static homography(src: readonly Point[], dst: readonly Point[]): Homography {
    if (src.length !== 4 || dst.length !== 4) throw new PixError(ErrorCode.InvalidGeometry, "homography needs 4 point pairs");
    const A: number[][] = [];
    const bvec: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i]!;
      const { x: u, y: v } = dst[i]!;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      bvec.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      bvec.push(v);
    }
    const h = Geometry.solveLinear(A, bvec);
    return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
  }

  static applyHomography(H: Homography, x: number, y: number): Point {
    const w = H[6] * x + H[7] * y + H[8];
    return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
  }

  /** Gaussian elimination with partial pivoting. */
  static solveLinear(A: number[][], b: number[]): number[] {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]!]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
      if (Math.abs(M[pivot]![col]!) < 1e-12) throw new PixError(ErrorCode.InvalidGeometry, "Singular system (degenerate quad)");
      [M[col], M[pivot]] = [M[pivot]!, M[col]!];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r]![col]! / M[col]![col]!;
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r]![c] = M[r]![c]! - f * M[col]![c]!;
      }
    }
    return M.map((row, i) => row[n]! / row[i]!);
  }
}
