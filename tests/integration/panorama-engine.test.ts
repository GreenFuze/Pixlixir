/**
 * Integration: the real panorama engine (vendored Pyodide + OpenCV + OpenStitching +
 * pixlixir_stitch.py) on synthetic overlapping photos. Requires `node scripts/vendor-pyodide.mjs`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import ExifReader from "exifreader";
import { loadPyodide } from "pyodide";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_STITCH_SETTINGS, StitchRuntime, type StitchSettings } from "../../src/imaging/panorama/stitch-runtime.js";
import type { RgbaImage } from "../../src/imaging/raster.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";
import { SyntheticScene } from "../fixtures/synthetic-scene.js";

const VENDOR = path.resolve("vendor/pyodide") + path.sep;

function assets() {
  const manifest = JSON.parse(readFileSync(path.join(VENDOR, "vendor-manifest.json"), "utf8")) as { packages: string[] };
  return {
    indexURL: VENDOR,
    packages: manifest.packages,
    driverSource: readFileSync("src/imaging/panorama/pixlixir_stitch.py", "utf8"),
  };
}

/** A plain photo with one faint, soft, tilted spot: next to no detail, the case that crashed the matcher. */
class PlainPhoto {
  static withSpot(amplitude: number): RgbaImage {
    const [width, height, base, sx, sy, cx, cy, theta] = [577, 433, 146, 29.78, 38.29, 181.2, 268.9, 2.186] as const;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const xr = (x - cx) * Math.cos(theta) + (y - cy) * Math.sin(theta);
      const yr = -(x - cx) * Math.sin(theta) + (y - cy) * Math.cos(theta);
      const v = base + amplitude * Math.exp(-((xr * xr) / (2 * sx * sx) + (yr * yr) / (2 * sy * sy)));
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
    return { width, height, data };
  }
}

describe("panorama engine (Pyodide + OpenCV)", () => {
  let runtime: StitchRuntime;
  const stages: string[] = [];

  beforeAll(async () => {
    runtime = await StitchRuntime.create(loadPyodide, assets(), (s) => stages.push(s));
  }, 120_000);

  afterAll(() => runtime?.dispose());

  const flat: StitchSettings = { ...DEFAULT_STITCH_SETTINGS, motion: "flat" };

  it("stitches three overlapping views of a flat scene back to its full width", () => {
    // Paragraph: three windows, 45% overlap, on one scene.
    const scene = SyntheticScene.textured(1500, 700, 7);
    const views = SyntheticScene.windows(scene, [0, 420, 840], 0, 660, 700);
    views.forEach((v, i) => runtime.setImage(i + 1, v.data, v.width, v.height));

    // Paragraph: full-resolution flat stitch.
    const out = runtime.stitch([1, 2, 3], flat, { kind: "full", maxMegapixels: 50 });
    expect(out.used.sort()).toEqual([1, 2, 3]);
    expect(out.dropped).toEqual([]);
    expect(out.width).toBeGreaterThan(1500 * 0.9);
    expect(out.width).toBeLessThan(1500 * 1.1);
    expect(out.height).toBeGreaterThan(700 * 0.85);
    expect(out.jpeg[0]).toBe(0xff);
    expect(out.jpeg[1]).toBe(0xd8);
    expect(stages).toContain("Matching photos");
  }, 120_000);

  it("fills ragged edges when asked and reports how much was made up", () => {
    // Paragraph: vertically staggered windows leave empty corners.
    const scene = SyntheticScene.textured(1500, 800, 11);
    const views = [SyntheticScene.window(scene, 0, 0, 660, 700), SyntheticScene.window(scene, 420, 100, 660, 700), SyntheticScene.window(scene, 840, 0, 660, 700)];
    views.forEach((v, i) => runtime.setImage(10 + i, v.data, v.width, v.height));

    const cropped = runtime.stitch([10, 11, 12], flat, { kind: "preview" });
    const filled = runtime.stitch([10, 11, 12], { ...flat, edges: "fill" }, { kind: "preview" });
    expect(cropped.filledFraction).toBe(0);
    expect(filled.filledFraction).toBeGreaterThan(0.01);
    expect(filled.fillOverlayPng).not.toBeNull();
    expect(filled.height).toBeGreaterThan(cropped.height);
  }, 120_000);

  it("reports photos that do not overlap as STITCH_NOT_CONNECTED", () => {
    const a = SyntheticScene.textured(700, 500, 21);
    const b = SyntheticScene.textured(700, 500, 99);
    runtime.setImage(30, a.data, a.width, a.height);
    runtime.setImage(31, b.data, b.width, b.height);
    let caught: unknown = null;
    try {
      runtime.stitch([30, 31], flat, { kind: "preview" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PixError);
    expect((caught as PixError).code).toBe(ErrorCode.StitchNotConnected);
  }, 120_000);

  it("caps full renders at the requested megapixels", () => {
    const out = runtime.stitch([1, 2, 3], flat, { kind: "full", maxMegapixels: 0.4 });
    expect(out.capped).toBe(true);
    expect((out.width * out.height) / 1e6).toBeLessThan(0.4 * 1.15);
  }, 120_000);

  it("finds panorama groups and sets aside duplicates and unrelated photos", () => {
    // Paragraph: capture order = a 3-view pan, a retake of view 2, an unrelated photo, then a 2-view pan.
    const scene = SyntheticScene.textured(1500, 700, 5);
    const other = SyntheticScene.textured(660, 700, 77);
    const second = SyntheticScene.textured(1100, 700, 13);
    const shots = [
      SyntheticScene.window(scene, 0, 0, 660, 700),
      SyntheticScene.window(scene, 420, 0, 660, 700),
      SyntheticScene.window(scene, 430, 5, 660, 690),
      SyntheticScene.window(scene, 840, 0, 660, 700),
      other,
      SyntheticScene.window(second, 0, 0, 660, 700),
      SyntheticScene.window(second, 440, 0, 660, 700),
    ];
    shots.forEach((v, i) => runtime.setImage(100 + i, v.data, v.width, v.height));

    // Paragraph: two groups; the retake is a duplicate of view 2; the unrelated photo is in neither.
    const r = runtime.findGroups(shots.map((_, i) => 100 + i));
    expect(r.groups).toEqual([
      { keys: [100, 101, 103], duplicates: [102] },
      { keys: [105, 106], duplicates: [] },
    ]);
  }, 120_000);

  it("does not take a burst of one view for a panorama", () => {
    // Paragraph: a pan to compare with; a burst whose framing wobbles, showing little more than one photo.
    const scene = SyntheticScene.textured(1500, 700, 21);
    const views = (xs: number[]) => SyntheticScene.windows(scene, xs, 0, 660, 700);
    const load = (shots: RgbaImage[], base: number) => { shots.forEach((v, i) => runtime.setImage(base + i, v.data, v.width, v.height)); return shots.map((_, i) => base + i); };
    expect(runtime.findGroups(load(views([0, 420, 840]), 200)).groups).toEqual([{ keys: [200, 201, 202], duplicates: [] }]);
    expect(runtime.findGroups(load(views([300, 440, 240]), 210)).groups).toEqual([]);

    // Paragraph: the camera moved plenty, but so did the subject: most of the overlap disagrees.
    const moved = views([0, 300]);
    for (const [shot, x] of [[moved[0]!, 300], [moved[1]!, 0]] as const) {
      for (let y = 40; y < 660; y++) {
        for (let px = x; px < x + 200; px++) {
          const i = (y * shot.width + px) * 4;
          shot.data[i] = x === 300 ? 250 : 5;
          shot.data[i + 1] = x === 300 ? 245 : 10;
          shot.data[i + 2] = x === 300 ? 240 : 20;
        }
      }
    }
    expect(runtime.findGroups(load(moved, 220)).groups).toEqual([]);
  }, 120_000);

  it("is not stopped by a photo with no detail: it just cannot be part of a panorama", () => {
    // Paragraph: seen on a real library: a solid image in a sequence crashed the matcher, and five in a row stopped the scan.
    const scene = SyntheticScene.textured(1500, 700, 11);
    const views = SyntheticScene.windows(scene, [0, 420, 840], 0, 660, 700);
    const blank = { width: 660, height: 700, data: new Uint8ClampedArray(660 * 700 * 4).fill(128) };
    const load = (imgs: RgbaImage[], first: number) => imgs.map((v, i) => { runtime.setImage(first + i, v.data, v.width, v.height); return first + i; });

    expect(runtime.findGroups(load([views[0]!, blank, views[1]!, views[2]!], 300)).groups).toEqual([{ keys: [300, 302, 303], duplicates: [] }]);
    expect(runtime.findGroups(load([blank, blank], 310)).groups).toEqual([]);
    expect(runtime.findGroups(load([blank, views[0]!], 320)).groups).toEqual([]);

    // Paragraph: the crash needs exactly one feature: one faint soft spot on a plain photo (found by search, measured in OpenCV 4.11).
    for (const [n, amp] of [26, 28, 30, 32, 34, 36].entries()) {
      const spot = PlainPhoto.withSpot(amp);
      expect(runtime.findGroups(load([spot, views[0]!, spot], 340 + n * 5)).groups).toEqual([]);
    }
    expect(runtime.findGroups(load([PlainPhoto.withSpot(32), PlainPhoto.withSpot(32)], 380)).groups).toEqual([]);
  }, 120_000);

  it("a photo with next to no detail in a chosen set is left out or explained, never an OpenCV error", () => {
    const scene = SyntheticScene.textured(1500, 700, 13);
    const views = SyntheticScene.windows(scene, [0, 420, 840], 0, 660, 700);
    const blank = { width: 660, height: 700, data: new Uint8ClampedArray(660 * 700 * 4).fill(128) };
    [views[0]!, blank, views[1]!, views[2]!].forEach((v, i) => runtime.setImage(330 + i, v.data, v.width, v.height));
    for (const amp of [26, 28, 30, 32, 34, 36]) {
      const [a, b] = [views[0]!, PlainPhoto.withSpot(amp)];
      runtime.setImage(390, a.data, a.width, a.height);
      runtime.setImage(391, b.data, b.width, b.height);
      try {
        runtime.stitch([390, 391], flat, { kind: "preview" });
      } catch (err) {
        expect(err).toBeInstanceOf(PixError);
        expect((err as PixError).details?.reason).not.toBe("OPENCV");
      }
    }
    let out;
    try {
      out = runtime.stitch([330, 331, 332, 333], flat, { kind: "preview" });
    } catch (err) {
      expect(err).toBeInstanceOf(PixError);
      expect((err as PixError).details?.reason).not.toBe("OPENCV");
      return;
    }
    expect(out.used).not.toContain(331);
    expect(out.dropped).toContain(331);
  }, 120_000);

  it("links pans whose matches are very strong (OpenCV zeroes their confidence)", () => {
    const scene = SyntheticScene.textured(1300, 700, 33);
    const shots = SyntheticScene.windows(scene, [0, 320, 640], 0, 660, 700);
    shots.forEach((v, i) => runtime.setImage(230 + i, v.data, v.width, v.height));
    expect(runtime.findGroups([230, 231, 232]).groups).toEqual([{ keys: [230, 231, 232], duplicates: [] }]);
  }, 120_000);

  it("reports how much more a stitched output shows than one photo", () => {
    const out = runtime.stitch([1, 2, 3], flat, { kind: "preview" });
    expect(out.viewGain).toBeGreaterThan(1.25);
    expect(out.shortSide).toBeGreaterThan(0.5);
  }, 120_000);

  it("writes the earliest photo's EXIF with Google's time and location into a saved panorama", async () => {
    // Paragraph: full render with inherited metadata (source has orientation 6, a MakerNote and a unique id).
    const head = new Uint8Array(readFileSync("tests/fixtures/exif-source.jpg"));
    const takenAtMs = Date.UTC(2024, 6, 14, 9, 30, 0);
    const out = runtime.stitch([1, 2, 3], flat, {
      kind: "full",
      maxMegapixels: 50,
      metadata: { sourceHead: head, takenAtMs, timezoneOffsetMs: 2 * 3600_000, location: { latitude: 48.8584, longitude: -2.2945 } },
    });

    // Paragraph: read it back with an independent EXIF reader.
    const tags = ExifReader.load(out.jpeg.buffer as ArrayBuffer, { expanded: true });
    expect(tags.exif?.Make?.description).toBe("PixTestCam");
    expect(tags.exif?.LensModel?.description).toBe("Synthetic 26mm");
    expect(tags.exif?.Orientation?.value).toBe(1);
    expect(tags.exif?.DateTimeOriginal?.description).toBe("2024:07:14 11:30:00");
    expect(tags.exif?.OffsetTimeOriginal?.description).toBe("+02:00");
    expect(tags.exif?.MakerNote).toBeUndefined();
    expect(tags.exif?.ImageUniqueID).toBeUndefined();
    expect(tags.exif?.PixelXDimension?.value).toBe(out.width);
    expect(tags.gps?.Latitude).toBeCloseTo(48.8584, 4);
    expect(tags.gps?.Longitude).toBeCloseTo(-2.2945, 4);
    expect(out.warnings).toEqual([]);
  }, 120_000);

  it("still saves with basic EXIF when the source header is unreadable, and says so", () => {
    const out = runtime.stitch([1, 2, 3], flat, { kind: "full", maxMegapixels: 50, metadata: { sourceHead: new Uint8Array([1, 2, 3]), takenAtMs: 0, timezoneOffsetMs: 0, location: null } });
    const tags = ExifReader.load(out.jpeg.buffer as ArrayBuffer, { expanded: true });
    expect(tags.exif?.DateTimeOriginal?.description).toBe("1970:01:01 00:00:00");
    expect(out.warnings.join(" ")).toMatch(/camera details were not copied/);
  }, 120_000);
});
