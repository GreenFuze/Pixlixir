/**
 * Snaps the sides of a rough print quad onto the print's real straight edges.
 *
 * Each side is searched over independent normal offsets of its two endpoints
 * (so it can also tilt). A candidate line is scored as a STEP: mean
 * background-distance just inside minus just outside. The print boundary is
 * the only line with "print inside, background outside"; textured
 * backgrounds (ribbed cloth) and edges inside the photo score near zero.
 * The result is validated; if anything looks off, the rough quad is kept.
 *
 * Use only on textured backgrounds: on a smooth bed a white print border is
 * indistinguishable from the background by colour, and the rough outline
 * (built from the paper-edge gradient) is already the accurate one.
 */

import { Geometry, type Point, type Quad } from "../geometry.js";
import type { GrayImage } from "../raster.js";

interface SnappedLine {
  line: [Point, Point];
  score: number;
  angle: number;
}

export class EdgeSnapper {
  constructor(
    /** Per-pixel distance from the background model (0..255). */
    private readonly distance: GrayImage,
    /** Search range as a fraction of the side length. */
    private readonly searchFraction = 0.15,
    /** Minimum inside-minus-outside step for a line to count as the print edge. */
    private readonly minStep = 10,
  ) {}

  snap(quad: Quad): Quad {
    // Paragraph: snap each side independently.
    const sides: (SnappedLine | null)[] = [0, 1, 2, 3].map((i) => this.bestLine(quad[i]!, quad[(i + 1) % 4]!, EdgeSnapper.outwardNormal(quad, i), null));

    // Paragraph: opposite sides of a print are nearly parallel. Re-snap the weaker (or missing) side of a
    // disagreeing pair within a few degrees of the stronger one, accepting a weaker step (pale print areas).
    for (const [i, j] of [[0, 2], [1, 3]] as const) {
      const a = sides[i], b = sides[j];
      if (!a && !b) continue;
      if (a && b && EdgeSnapper.angleDiff(a.angle, b.angle) <= EdgeSnapper.PARALLEL_TOLERANCE) continue;
      const weak = !a ? i : !b ? j : a.score >= b.score ? j : i;
      const strong = (weak === i ? b : a)!;
      sides[weak] = this.bestLine(quad[weak]!, quad[(weak + 1) % 4]!, EdgeSnapper.outwardNormal(quad, weak), strong.angle, this.minStep / 3);
    }
    const lines = sides.map((l, i) => (l ? l.line : ([quad[i]!, quad[(i + 1) % 4]!] as [Point, Point])));

    // Paragraph: corners = intersections of adjacent lines.
    const corners: Point[] = [];
    for (let i = 0; i < 4; i++) {
      const prev = lines[(i + 3) % 4]!, cur = lines[i]!;
      const x = Geometry.lineIntersection(prev[0], prev[1], cur[0], cur[1]);
      if (!x) return quad;
      corners.push(x);
    }

    // Paragraph: validate (convex, similar area, corners moved a bounded amount).
    const snapped = Geometry.orderCorners(corners);
    const before = Geometry.polygonArea(quad), after = Geometry.polygonArea(snapped);
    const moved = quad.every((p, i) => Math.hypot(p.x - snapped[i]!.x, p.y - snapped[i]!.y) < 0.25 * Math.sqrt(before));
    if (!EdgeSnapper.isConvex(snapped) || after < 0.5 * before || after > 1.1 * before || !moved) return quad;
    return snapped;
  }

  /** Max undirected angle difference (radians) between opposite sides. */
  static readonly PARALLEL_TOLERANCE = (4 * Math.PI) / 180;

  private bestLine(a: Point, b: Point, n: Point, targetAngle: number | null, minStep = this.minStep): SnappedLine | null {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const range = Math.max(2, Math.round(len * this.searchFraction));
    const samples = Math.max(8, Math.min(160, Math.round(len * 0.6)));
    const at = (da: number, db: number) => ({ pa: { x: a.x + n.x * da, y: a.y + n.y * da }, pb: { x: b.x + n.x * db, y: b.y + n.y * db } });
    const allowed = (pa: Point, pb: Point) =>
      targetAngle === null || EdgeSnapper.angleDiff(Math.atan2(pb.y - pa.y, pb.x - pa.x), targetAngle) <= EdgeSnapper.PARALLEL_TOLERANCE / 2;

    // Paragraph: coarse search (step 2), then refine around the best (step 1).
    const state: { best: { da: number; db: number; score: number } | null } = { best: null };
    const consider = (da: number, db: number) => {
      const { pa, pb } = at(da, db);
      if (!allowed(pa, pb)) return;
      const score = this.lineScore(pa, pb, n, samples);
      const b0 = state.best;
      if (!b0 || score > b0.score || (score === b0.score && da + db > b0.da + b0.db)) state.best = { da, db, score };
    };
    for (let da = -range; da <= range; da += 2) for (let db = -range; db <= range; db += 2) consider(da, db);
    const coarse = state.best;
    if (!coarse) return null;
    for (let da = coarse.da - 2; da <= coarse.da + 2; da++) for (let db = coarse.db - 2; db <= coarse.db + 2; db++) consider(da, db);
    const pick = state.best as { da: number; db: number; score: number } | null;
    if (!pick || pick.score < minStep) return null;

    const { pa, pb } = at(pick.da, pick.db);
    return { line: [pa, pb], score: pick.score, angle: Math.atan2(pb.y - pa.y, pb.x - pa.x) };
  }

  /** Undirected angle difference in [0, π/2]. */
  static angleDiff(a: number, b: number): number {
    let d = Math.abs(a - b) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return d;
  }

  /**
   * Median over the central 80% of pa→pb of (distance inside − distance outside),
   * n = outward normal. The median requires the step along most of the side, so
   * a local blob next to the print (a pattern on the cloth) cannot pull the line.
   */
  private lineScore(pa: Point, pb: Point, n: Point, samples: number): number {
    const { width: w, height: h, data } = this.distance;
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const steps: number[] = [];
    for (let s = 0; s < samples; s++) {
      const t = 0.1 + (0.8 * s) / (samples - 1);
      const x = pa.x + dx * t, y = pa.y + dy * t;
      let inside = 0, outside = 0, count = 0;
      for (let k = 2; k <= 4; k++) {
        const xi = Math.round(x - n.x * k), yi = Math.round(y - n.y * k);
        const xo = Math.round(x + n.x * k), yo = Math.round(y + n.y * k);
        if (xi < 0 || yi < 0 || xi >= w || yi >= h || xo < 0 || yo < 0 || xo >= w || yo >= h) continue;
        inside += Math.min(100, data[yi * w + xi]!);
        outside += Math.min(100, data[yo * w + xo]!);
        count++;
      }
      if (count > 0) steps.push((inside - outside) / count);
    }
    if (steps.length < samples / 2) return 0;
    steps.sort((a, b) => a - b);
    return steps[Math.floor(steps.length / 2)]!;
  }

  /** Unit normal of side i pointing away from the quad's centroid. */
  static outwardNormal(q: Quad, i: number): Point {
    const a = q[i]!, b = q[(i + 1) % 4]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    if ((a.x - cx) * n.x + (a.y - cy) * n.y < 0) n = { x: -n.x, y: -n.y };
    return n;
  }

  static isConvex(q: Quad): boolean {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i]!, b = q[(i + 1) % 4]!, c = q[(i + 2) % 4]!;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cross === 0) return false;
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
    return true;
  }
}
