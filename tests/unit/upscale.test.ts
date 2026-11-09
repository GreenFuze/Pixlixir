import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { Raster, type RgbaImage } from "../../src/imaging/raster.js";
import { TilePlan, Upscaler, type UpscaleModel } from "../../src/imaging/upscale/upscaler.js";
import { ErrorCode } from "../../src/shared/errors.js";

/** Stand-in model: each pixel becomes a 4 x 4 block, so results are exact and checkable. */
class BlockModel implements UpscaleModel {
  calls = 0;
  async run(rgb: Float32Array, w: number, h: number): Promise<Float32Array> {
    this.calls++;
    const n = w * h, out = new Float32Array(3 * n * 16);
    for (let c = 0; c < 3; c++) for (let y = 0; y < 4 * h; y++) for (let x = 0; x < 4 * w; x++) out[c * n * 16 + y * 4 * w + x] = rgb[c * n + (y >> 2) * w + (x >> 2)]!;
    return out;
  }
}

/** The model shipped in the extension, on the CPU. */
class OnnxModel implements UpscaleModel {
  private constructor(private readonly session: ort.InferenceSession) {}
  static async load(): Promise<OnnxModel> {
    ort.env.wasm.numThreads = 1;
    return new OnnxModel(await ort.InferenceSession.create(readFileSync("src/extension/models/realesr-general-x4v3-grain.onnx"), { executionProviders: ["wasm"] }));
  }
  async run(rgb: Float32Array, w: number, h: number, smooth: number): Promise<Float32Array> {
    const out = await this.session.run({ image: new ort.Tensor("float32", rgb, [1, 3, h, w]), strength: new ort.Tensor("float32", new Float32Array([smooth]), [1]) });
    return out["upscaled"]!.data as Float32Array;
  }
}

const collect = (width: number, height: number) => {
  const img = Raster.createRgba(width, height);
  return { img, put: (tile: RgbaImage, x: number, y: number) => { for (let r = 0; r < tile.height; r++) img.data.set(tile.data.subarray(r * tile.width * 4, (r + 1) * tile.width * 4), ((y + r) * width + x) * 4); } };
};

/** Sharp shapes: stripes of several widths, a disc and a diagonal edge, as a camera might see them. */
function scene(size: number): RgbaImage {
  const img = Raster.createRgba(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const stripe = x < size / 2 ? (Math.floor(x / (2 + Math.floor(y / 24))) % 2) * 200 + 30 : 0;
    const disc = Math.hypot(x - size * 0.75, y - size * 0.3) < size * 0.18 ? 220 : 40;
    const edge = x + y > size * 1.3 ? 180 : 70;
    const v = x < size / 2 ? stripe : y < size / 2 ? disc : edge;
    img.data.set([v, Math.min(255, v + 20), Math.max(0, v - 20), 255], (y * size + x) * 4);
  }
  return img;
}

/** Each 4 x 4 block averaged, like a camera with fewer pixels. */
function shrink4(src: RgbaImage): RgbaImage {
  const out = Raster.createRgba(src.width / 4, src.height / 4);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) s += src.data[((4 * y + dy) * src.width + 4 * x + dx) * 4 + c]!;
    out.data[(y * out.width + x) * 4 + c] = Math.round(s / 16);
  }
  return out;
}

/** Plain enlargement by bilinear interpolation, the baseline to beat. */
function bilinear4(src: RgbaImage): RgbaImage {
  const out = Raster.createRgba(src.width * 4, src.height * 4);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const fx = Math.max(0, Math.min(src.width - 1, (x + 0.5) / 4 - 0.5)), fy = Math.max(0, Math.min(src.height - 1, (y + 0.5) / 4 - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
    for (let c = 0; c < 4; c++) {
      const p = (xx: number, yy: number) => src.data[(yy * src.width + xx) * 4 + c]!;
      out.data[(y * out.width + x) * 4 + c] = (1 - ay) * ((1 - ax) * p(x0, y0) + ax * p(x1, y0)) + ay * ((1 - ax) * p(x0, y1) + ax * p(x1, y1));
    }
  }
  return out;
}

/** Mean size of the brightness step between neighbouring pixels: higher is sharper. */
function sharpness(img: RgbaImage): number {
  let s = 0, n = 0;
  for (let y = 0; y < img.height - 1; y++) for (let x = 0; x < img.width - 1; x++) {
    const i = (y * img.width + x) * 4;
    s += Math.abs(img.data[i]! - img.data[i + 4]!) + Math.abs(img.data[i]! - img.data[i + img.width * 4]!);
    n += 2;
  }
  return s / n;
}

function psnr(a: RgbaImage, b: RgbaImage): number {
  let se = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) { se += (a.data[i + c]! - b.data[i + c]!) ** 2; n++; }
  return 10 * Math.log10((255 * 255) / (se / n));
}

describe("TilePlan", () => {
  it("covers every pixel exactly once, and reads a margin inside the photo", () => {
    const tiles = TilePlan.of(500, 300, 192, 16);
    const hits = new Uint8Array(500 * 300);
    for (const t of tiles) {
      for (let y = t.y; y < t.y + t.height; y++) for (let x = t.x; x < t.x + t.width; x++) hits[y * 500 + x]!++;
      expect(t.readX).toBeGreaterThanOrEqual(0);
      expect(t.readX + t.readWidth).toBeLessThanOrEqual(500);
      expect(t.x - t.readX).toBe(t.x === 0 ? 0 : 16);
    }
    expect(hits.every((h) => h === 1)).toBe(true);
    expect(tiles).toHaveLength(6);
  });
});

describe("Upscaler", () => {
  const photo = (w: number, h: number) => { const img = Raster.createRgba(w, h); for (let i = 0; i < w * h; i++) img.data.set([i % 251, (i * 7) % 253, (i * 13) % 255, 255], i * 4); return img; };

  it("puts every tile back where it belongs, at 4x and at 2x", async () => {
    const src = photo(410, 230);
    for (const factor of [4, 2] as const) {
      const sink = collect(410 * factor, 230 * factor);
      await new Upscaler(new BlockModel()).upscale(src, factor, 0.5, sink);
      for (const [x, y] of [[0, 0], [409, 229], [191, 192], [200, 17]] as const) {
        expect([...sink.img.data.subarray(((y * factor + 1) * 410 * factor + x * factor + 1) * 4, ((y * factor + 1) * 410 * factor + x * factor + 1) * 4 + 4)]).toEqual([...src.data.subarray((y * 410 + x) * 4, (y * 410 + x) * 4 + 4)]);
      }
    }
  });

  it("refuses a result over the limit, a bad setting, and a model that returns the wrong size", async () => {
    const sink = collect(1, 1);
    expect(Upscaler.fits(4000, 3000, 2)).toBe(true);
    expect(Upscaler.fits(4000, 3000, 4)).toBe(false);
    await expect(new Upscaler(new BlockModel()).upscale(photo(4000, 3000), 4, 0.5, sink)).rejects.toMatchObject({ code: ErrorCode.OutOfMemory });
    await expect(new Upscaler(new BlockModel()).upscale(photo(8, 8), 4, 1.5, sink)).rejects.toThrow(/between 0 and 1/);
    const wrong: UpscaleModel = { run: async () => new Float32Array(5) };
    await expect(new Upscaler(wrong).upscale(photo(8, 8), 4, 0.5, sink)).rejects.toMatchObject({ code: ErrorCode.LocalEngineFailed });
  });

  it("stops when cancelled", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(new Upscaler(new BlockModel()).upscale(photo(8, 8), 2, 0.5, collect(16, 16), () => {}, stop.signal)).rejects.toMatchObject({ code: ErrorCode.Cancelled });
  });
});

describe("The shipped model", () => {
  it("restores sharp edges that plain enlarging blurs, no less faithfully, with no seams between tiles", async () => {
    // Paragraph: a sharp scene, shrunk 4x, enlarged back by the model and by bilinear.
    const truth = scene(256);
    const small = shrink4(truth);
    const model = await OnnxModel.load();
    const sink = collect(256, 256);
    await new Upscaler(model).upscale(small, 4, 0.5, sink);
    const plain = bilinear4(small);
    const edges = { truth: sharpness(truth), model: sharpness(sink.img), plain: sharpness(plain) };
    const faithful = { model: psnr(sink.img, truth), plain: psnr(plain, truth) };
    console.log("[upscale] sharpness", edges, "psnr", faithful);
    expect(Math.abs(edges.model - edges.truth)).toBeLessThan(Math.abs(edges.plain - edges.truth) / 2);
    expect(faithful.model).toBeGreaterThan(faithful.plain);

    // Paragraph: tiling must not change the picture: the same area in one piece matches.
    const whole = await model.run(Upscaler.planar(small, { x: 0, y: 0, width: 64, height: 64, readX: 0, readY: 0, readWidth: 64, readHeight: 64 }), 64, 64, 0.5);
    const one = Upscaler.crop(whole, { x: 0, y: 0, width: 64, height: 64, readX: 0, readY: 0, readWidth: 64, readHeight: 64 });
    let worst = 0;
    for (let i = 0; i < one.data.length; i++) worst = Math.max(worst, Math.abs(one.data[i]! - sink.img.data[i]!));
    expect(worst).toBeLessThanOrEqual(1);
  }, 120_000);

  it("keeps more grain at 0 than at 1", async () => {
    // Paragraph: a flat grey with grain; what is left of the grain after enlarging.
    const grainy = Raster.createRgba(48, 48);
    let seed = 7;
    for (let i = 0; i < 48 * 48; i++) { seed = (seed * 1103515245 + 12345) % 2 ** 31; const v = 128 + ((seed >> 16) % 41) - 20; grainy.data.set([v, v, v, 255], i * 4); }
    const model = await OnnxModel.load();
    const spread = async (smooth: number) => {
      const sink = collect(192, 192);
      await new Upscaler(model).upscale(grainy, 4, smooth, sink);
      let s = 0, s2 = 0, n = 0;
      for (let i = 0; i < sink.img.data.length; i += 4) { s += sink.img.data[i]!; s2 += sink.img.data[i]! ** 2; n++; }
      return Math.sqrt(s2 / n - (s / n) ** 2);
    };
    const kept = await spread(0), smoothed = await spread(1);
    expect(kept).toBeGreaterThan(smoothed * 1.5);
  }, 120_000);
});
