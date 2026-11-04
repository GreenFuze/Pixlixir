import { describe, expect, it } from "vitest";
import { Geometry, type Point, type Quad } from "../../src/imaging/geometry.js";
import { Raster } from "../../src/imaging/raster.js";
import { PrintDetector } from "../../src/imaging/split/detector.js";
import { PerspectiveWarper } from "../../src/imaging/warp.js";
import { SyntheticScan } from "../fixtures/synthetic-scan.js";

/** Max distance between each detected corner and its nearest ground-truth corner. */
function cornerError(quad: Quad, truth: Point[]): number {
  return Math.max(...quad.map((p) => Math.min(...truth.map((t) => Math.hypot(p.x - t.x, p.y - t.y)))));
}

describe("Geometry", () => {
  it("computes a homography that maps the 4 correspondences", () => {
    const src = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    const dst = [{ x: 10, y: 20 }, { x: 120, y: 5 }, { x: 130, y: 90 }, { x: 0, y: 70 }];
    const H = Geometry.homography(src, dst);
    src.forEach((p, i) => {
      const q = Geometry.applyHomography(H, p.x, p.y);
      expect(q.x).toBeCloseTo(dst[i]!.x, 6);
      expect(q.y).toBeCloseTo(dst[i]!.y, 6);
    });
  });

  it("finds the minimum-area rectangle of a rotated rectangle", () => {
    const a = (30 * Math.PI) / 180;
    const corners = [[-50, -20], [50, -20], [50, 20], [-50, 20]].map(([x, y]) => ({ x: 200 + x! * Math.cos(a) - y! * Math.sin(a), y: 200 + x! * Math.sin(a) + y! * Math.cos(a) }));
    const { area, quad } = Geometry.minAreaRect(Geometry.convexHull(corners));
    expect(area).toBeCloseTo(100 * 40, 3);
    expect(cornerError(quad, corners)).toBeLessThan(1e-6);
  });

  it("orders corners TL, TR, BR, BL", () => {
    const q = Geometry.orderCorners([{ x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(q).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]);
  });

  it("rejects degenerate input", () => {
    expect(() => Geometry.minAreaRect([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow(/at least 3/);
  });
});

describe("PrintDetector", () => {
  it("detects three tilted prints on a dark album page", () => {
    const scan = new SyntheticScan(1200, 900, [40, 35, 30]);
    const truths = [
      scan.addPrint({ cx: 250, cy: 250, w: 300, h: 220, angleDeg: 4, seed: 1 }),
      scan.addPrint({ cx: 800, cy: 260, w: 280, h: 340, angleDeg: -7, seed: 2 }),
      scan.addPrint({ cx: 450, cy: 680, w: 420, h: 260, angleDeg: 12, seed: 3 }),
    ];
    const prints = new PrintDetector().detect(scan.image);
    expect(prints).toHaveLength(3);
    // Reading order: top-left, top-right, bottom.
    prints.forEach((p, i) => {
      expect(cornerError(p.quad, truths[i]!)).toBeLessThan(6);
      expect(p.confidence).toBeGreaterThan(0.8);
    });
  });

  it("detects white-bordered prints on a white scanner bed via the paper edge", () => {
    const scan = new SyntheticScan(1000, 800, [245, 245, 245], 2);
    const truths = [
      scan.addPrint({ cx: 280, cy: 400, w: 380, h: 300, angleDeg: -3, seed: 4, border: { rgb: [246, 246, 244], width: 18 }, edgeShadow: true }),
      scan.addPrint({ cx: 740, cy: 380, w: 300, h: 420, angleDeg: 6, seed: 5, border: { rgb: [246, 246, 244], width: 18 }, edgeShadow: true }),
    ];
    const prints = new PrintDetector().detect(scan.image);
    expect(prints).toHaveLength(2);
    prints.forEach((p, i) => expect(cornerError(p.quad, truths[i]!)).toBeLessThan(8));
  });

  it("returns nothing for an empty background", () => {
    const scan = new SyntheticScan(600, 400, [200, 200, 200]);
    expect(new PrintDetector().detect(scan.image)).toHaveLength(0);
  });

  it("rejects malformed buffers", () => {
    expect(() => new PrintDetector().detect({ width: 10, height: 10, data: new Uint8ClampedArray(5) })).toThrow(/does not match/);
  });
});

describe("PerspectiveWarper", () => {
  it("rectifies a rotated print back to its upright size and content", () => {
    const scan = new SyntheticScan(800, 600, [30, 30, 30]);
    const truth = scan.addPrint({ cx: 400, cy: 300, w: 300, h: 200, angleDeg: 20, seed: 9 });
    const out = PerspectiveWarper.rectify(scan.image, Geometry.orderCorners(truth));
    expect(out.width).toBe(300);
    expect(out.height).toBe(200);
    // No background (dark) pixels should leak in away from the edges.
    let dark = 0;
    for (let y = 3; y < out.height - 3; y++) for (let x = 3; x < out.width - 3; x++) {
      const i = (y * out.width + x) * 4;
      if (out.data[i]! < 40 && out.data[i + 1]! < 40 && out.data[i + 2]! < 40) dark++;
    }
    expect(dark).toBe(0);
  });

  it("rotates by quarter turns", () => {
    const img = Raster.createRgba(3, 2);
    img.data.set([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255]);
    const r = Raster.rotate90(img, 1);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect([r.data[0], r.data[4]]).toEqual([4, 1]);
  });
});
