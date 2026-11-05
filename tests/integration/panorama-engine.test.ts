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
