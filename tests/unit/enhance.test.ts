import { describe, expect, it } from "vitest";
import { AdjustmentPresets, type Adjustments } from "../../src/imaging/enhance/adjustments.js";
import { IlluminationField } from "../../src/imaging/enhance/illumination.js";
import { PullPushInpainter } from "../../src/imaging/enhance/inpaint.js";
import { EnhancePipeline } from "../../src/imaging/enhance/pipeline.js";
import { StrokeRasterizer } from "../../src/imaging/enhance/repair.js";
import { ColorRestorer } from "../../src/imaging/enhance/tone.js";
import { Raster, type RgbaImage } from "../../src/imaging/raster.js";
import { SyntheticScan } from "../fixtures/synthetic-scan.js";

function solid(w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const img = Raster.createRgba(w, h);
  for (let i = 0; i < w * h; i++) img.data.set([...rgb, 255], i * 4);
  return img;
}

function at(img: RgbaImage, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

function only(patch: Partial<Adjustments>): Adjustments {
  return { ...AdjustmentPresets.none(), ...patch };
}

const noCtx = { lightingGain: null, wantMask: false };

describe("PullPushInpainter", () => {
  it("fills an unknown hole from its surroundings", () => {
    const img = solid(64, 64, [40, 120, 200]);
    const known = new Float32Array(64 * 64).fill(1);
    for (let y = 20; y < 44; y++) for (let x = 20; x < 44; x++) { img.data.set([255, 0, 0, 255], (y * 64 + x) * 4); known[y * 64 + x] = 0; }
    const out = PullPushInpainter.fill(img, known);
    at(out, 32, 32).forEach((v, c) => expect(Math.abs(v - [40, 120, 200][c]!)).toBeLessThan(3));
  });
});

describe("Glare brush", () => {
  it("removes a painted white veil and recovers the underlying colour", () => {
    const img = solid(200, 160, [60, 90, 150]);
    // Soft veil: observed = (1-a)*true + a*250, a peaks at 0.5 in the centre.
    for (let y = 0; y < 160; y++) for (let x = 0; x < 200; x++) {
      const a = 0.5 * Math.max(0, 1 - Math.hypot(x - 100, y - 80) / 45);
      const i = (y * 200 + x) * 4;
      for (let c = 0; c < 3; c++) img.data[i + c] = img.data[i + c]! * (1 - a) + 250 * a;
    }
    const stroke = { kind: "glare" as const, radius: 0.3, points: [{ u: 0.5, v: 0.5 }] };
    const out = EnhancePipeline.apply(img, only({ strokes: [stroke] }), noCtx).image;
    const before = at(img, 100, 80), after = at(out, 100, 80);
    expect(before[2]! - 150).toBeGreaterThan(40);
    after.forEach((v, c) => expect(Math.abs(v - [60, 90, 150][c]!)).toBeLessThan(25));
  });

  it("leaves unpainted pixels untouched", () => {
    const img = solid(50, 50, [10, 200, 30]);
    const out = EnhancePipeline.apply(img, only({ strokes: [{ kind: "glare", radius: 0.1, points: [{ u: 0.2, v: 0.2 }] }] }), noCtx).image;
    expect(at(out, 45, 45)).toEqual([10, 200, 30]);
  });
});

describe("Repair brush", () => {
  it("fills a painted scratch from the surroundings", () => {
    const img = solid(120, 80, [180, 160, 120]);
    for (let x = 10; x < 110; x++) img.data.set([0, 0, 0, 255], (40 * 120 + x) * 4);
    const stroke = { kind: "repair" as const, radius: 0.02, points: [{ u: 0.05, v: 40.5 / 80 }, { u: 0.95, v: 40.5 / 80 }] };
    const out = EnhancePipeline.apply(img, only({ strokes: [stroke] }), noCtx).image;
    at(out, 60, 40).forEach((v, c) => expect(Math.abs(v - [180, 160, 120][c]!)).toBeLessThan(10));
  });

  it("rasterises strokes at any resolution", () => {
    const { repair, glare, protect } = StrokeRasterizer.masks([{ kind: "repair", radius: 0.1, points: [{ u: 0.5, v: 0.5 }] }], 100, 100);
    expect(glare).toBeNull();
    expect(protect).toBeNull();
    expect(repair![50 * 100 + 50]).toBe(1);
    expect(repair![5 * 100 + 5]).toBe(0);
  });
});

describe("Dust & scratches", () => {
  it("removes small specks but keeps large features", () => {
    const img = solid(300, 200, [120, 120, 120]);
    for (const [x, y] of [[50, 50], [200, 80], [120, 150]] as [number, number][]) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) img.data.set([255, 255, 255, 255], ((y + dy) * 300 + x + dx) * 4);
    for (let y = 100; y < 160; y++) for (let x = 200; x < 270; x++) img.data.set([20, 20, 20, 255], (y * 300 + x) * 4);
    const out = EnhancePipeline.apply(img, only({ dust: { enabled: true, sensitivity: 0.5 } }), noCtx).image;
    expect(at(out, 50, 50)[0]).toBeLessThan(140);
    expect(at(out, 235, 130)[0]).toBe(20);
  });
});

describe("ColorRestorer", () => {
  it("restore mode stretches a faded, yellowed print and neutralises the cast", () => {
    const img = Raster.createRgba(100, 100);
    for (let i = 0; i < 100 * 100; i++) {
      const g = (i % 100) * 2.55;
      img.data.set([90 + g * 0.45, 85 + g * 0.42, 60 + g * 0.3, 255], i * 4);
    }
    const out = ColorRestorer.apply(img, "restore", 1);
    const dark = at(out, 1, 50), light = at(out, 98, 50);
    expect(light[0]! - dark[0]!).toBeGreaterThan(200);
    expect(Math.abs(light[0]! - light[2]!)).toBeLessThan(15);
  });

  it("preserve mode keeps the colour relationship between channels", () => {
    const img = solid(10, 10, [150, 120, 80]);
    img.data.set([100, 80, 50, 255], 0);
    const out = ColorRestorer.apply(img, "preserve", 1);
    const p = at(out, 5, 5);
    expect(p[0]!).toBeGreaterThan(p[1]!);
    expect(p[1]!).toBeGreaterThan(p[2]!);
  });
});

describe("IlluminationField", () => {
  it("measures a shadow from the surrounding surface and lifts the print under it", () => {
    const scan = new SyntheticScan(1000, 700, [200, 195, 185], 1);
    const print = scan.addPrint({ cx: 300, cy: 350, w: 260, h: 200, angleDeg: 0, seed: 3 });
    scan.shade((x) => 0.5 + 0.5 * (x / 1000)); // dark on the left
    const field = IlluminationField.estimate(scan.image);
    expect(field).not.toBeNull();
    const quad = print as [typeof print[0], typeof print[0], typeof print[0], typeof print[0]];
    const gain = field!.gainPlane(quad, 260, 200, 1);
    // Left side of the print is darker than its right side, so it must get more gain.
    expect(gain[100 * 260 + 5]!).toBeGreaterThan(gain[100 * 260 + 255]!);
    expect(gain[100 * 260 + 5]!).toBeGreaterThan(1.3);
  });

  it("reports itself unavailable on a surface that is not a usable light probe", () => {
    const scan = new SyntheticScan(400, 300, [0, 0, 0], 0);
    const rng = SyntheticScan.rng(5);
    for (let i = 0; i < 400 * 300; i++) scan.image.data.set([rng() * 255, rng() * 255, rng() * 255, 255], i * 4);
    expect(IlluminationField.estimate(scan.image)).toBeNull();
  });
});

describe("EnhancePipeline", () => {
  it("is the identity when nothing is enabled", () => {
    const img = solid(20, 20, [1, 2, 3]);
    const out = EnhancePipeline.apply(img, AdjustmentPresets.none(), noCtx);
    expect(out.image).toBe(img);
    expect(AdjustmentPresets.isIdentity(AdjustmentPresets.none())).toBe(true);
  });

  it("skips lighting honestly when no scene measurement is available", () => {
    const out = EnhancePipeline.apply(solid(20, 20, [100, 100, 100]), only({ lighting: { enabled: true, strength: 1 } }), noCtx);
    expect(out.report.lightingApplied).toBe(false);
  });
});
