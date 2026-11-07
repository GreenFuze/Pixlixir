/** Edit with AI: what is sent, where a result goes, what gets pasted, and which details survive. */

import ExifReader from "exifreader";
import jpeg from "jpeg-js";
import piexif from "piexifjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditPrompt, EDIT_PRESETS } from "../../src/extension/editor/edit/edit-presets.js";
import { ResultInput } from "../../src/extension/editor/edit/result-input.js";
import { ServiceSignIn, ServiceUrl } from "../../src/extension/editor/edit/ai-services.js";
import { A1111Engine, ENGINE_KINDS, EngineCommands, IoPaintEngine, LocalAddress } from "../../src/extension/editor/edit/local-engines.js";
import { EditRegion } from "../../src/imaging/edit/edit-region.js";
import { ExifCarry } from "../../src/imaging/edit/exif-carry.js";
import { EditMarking, PasteBack, ResultFit } from "../../src/imaging/edit/result-fit.js";
import type { BrushStroke } from "../../src/imaging/enhance/adjustments.js";
import type { RgbaImage } from "../../src/imaging/raster.js";

/** A picture with detail everywhere, unlike a flat test card. */
function scene(width: number, height: number, seed = 0): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0, k = 0; y < height; y++) {
    for (let x = 0; x < width; x++, k += 4) {
      const u = x / width, v = y / height;
      const g = 128 + 60 * Math.sin((u + seed) * 19) * Math.cos((v + seed) * 13) + 50 * Math.sin((u * 7 + v * 11) * 3);
      data[k] = g; data[k + 1] = g * 0.8 + 20; data[k + 2] = 255 - g; data[k + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Draws `src` into a new picture: the placement a service's reframing would produce, inverted. */
function reframed(src: RgbaImage, width: number, height: number, rect: { x: number; y: number; width: number; height: number }): RgbaImage {
  const out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  for (let y = 0, k = 0; y < height; y++) {
    for (let x = 0; x < width; x++, k += 4) {
      const u = rect.x + ((x + 0.5) / width) * rect.width, v = rect.y + ((y + 0.5) / height) * rect.height;
      const sx = Math.max(0, Math.min(src.width - 1, Math.floor(u * src.width))), sy = Math.max(0, Math.min(src.height - 1, Math.floor(v * src.height)));
      const i = (sy * src.width + sx) * 4;
      for (let c = 0; c < 4; c++) out.data[k + c] = src.data[i + c]!;
    }
  }
  return out;
}

const stroke = (u: number, v: number, radius = 0.05): BrushStroke => ({ kind: "repair", radius, points: [{ u, v }] });

describe("EditRegion", () => {
  it("sends the brush with surroundings, inside the photo", () => {
    const bounds = EditRegion.strokeBounds([stroke(0.5, 0.5, 0.05)], 4000, 3000)!;
    expect(bounds).toEqual({ x: 1800, y: 1300, width: 400, height: 400 });
    const region = EditRegion.around(bounds, 4000, 3000);
    expect(region).toEqual({ x: 1560, y: 1060, width: 880, height: 880 });
  });

  it("moves the crop back inside at the photo's corner", () => {
    const region = EditRegion.around(EditRegion.strokeBounds([stroke(0.99, 0.99, 0.01)], 4000, 3000)!, 4000, 3000);
    expect(region.x + region.width).toBe(4000);
    expect(region.y + region.height).toBe(3000);
  });

  it("sends at least the smallest crop around a small brush", () => {
    const small = EditRegion.around({ x: 1990, y: 1490, width: 20, height: 20 }, 4000, 3000);
    expect(small).toEqual({ x: 1616, y: 1116, width: 768, height: 768 });
  });

  it("sends the whole of a photo smaller than the smallest crop", () => {
    expect(EditRegion.around({ x: 10, y: 10, width: 20, height: 20 }, 500, 400)).toEqual({ x: 0, y: 0, width: 500, height: 400 });
  });

  it("has no region without strokes", () => {
    expect(EditRegion.strokeBounds([], 100, 100)).toBeNull();
  });

  it("keeps a stroke on the same pixels when seen from the crop", () => {
    const W = 4000, H = 3000;
    const s = stroke(0.6, 0.4, 0.02);
    const region = EditRegion.around(EditRegion.strokeBounds([s], W, H)!, W, H);
    const mask = EditRegion.mask(EditRegion.relative([s], region, W, H), region.width, region.height);
    const cx = Math.round(0.6 * W - region.x), cy = Math.round(0.4 * H - region.y), r = 0.02 * W;
    expect(mask[cy * region.width + cx]).toBeCloseTo(1, 2);
    expect(mask[cy * region.width + Math.round(cx + r * 1.2)]).toBe(0); // just outside the brush
    expect(mask[cy * region.width + Math.round(cx + r * 0.7)]).toBeCloseTo(1, 2); // just inside
  });
});

describe("EditMarking and PasteBack", () => {
  const blank = (v: number): RgbaImage => ({ width: 2, height: 1, data: new Uint8ClampedArray([v, v, v, 255, v, v, v, 255]) });

  it("tints only the brushed pixels", () => {
    const out = EditMarking.mark(blank(100), new Float32Array([1, 0]));
    expect([...out.data.slice(0, 3)]).toEqual([193, 40, 193]);
    expect([...out.data.slice(4, 7)]).toEqual([100, 100, 100]);
  });

  it("changes only the brushed pixels", () => {
    const out = PasteBack.apply(blank(10), blank(200), new Float32Array([1, 0]));
    expect(out.data[0]).toBe(200);
    expect(out.data[4]).toBe(10);
  });

  it("keeps the photo where the result does not reach", () => {
    const top = blank(200);
    top.data[3] = 0;
    expect(PasteBack.apply(blank(10), top, new Float32Array([1, 1])).data[0]).toBe(10);
  });

  it("refuses pictures of different sizes", () => {
    expect(() => PasteBack.apply(blank(1), { width: 1, height: 1, data: new Uint8ClampedArray(4) }, new Float32Array(2))).toThrow(/differ in size/);
  });
});

describe("ResultFit", () => {
  const W = 64, H = 48;
  const noBrush = new Float32Array(W * H);
  const brushed = EditRegion.mask([stroke(0.5, 0.5, 0.15)], W, H);

  it("takes an unchanged result where it stands", () => {
    const fit = ResultFit.estimate(scene(W, H), scene(W, H), noBrush);
    expect(fit.linesUp).toBe(true);
    expect(fit.rect.x).toBeCloseTo(0, 1);
    expect(fit.rect.width).toBeCloseTo(1, 1);
  });

  it("finds a result that was slightly zoomed and moved", () => {
    const rect = { x: 0.04, y: 0.03, width: 0.92, height: 0.94 };
    const fit = ResultFit.estimate(scene(W, H), reframed(scene(W, H), W, H, rect), noBrush);
    // The result shows rect of the photo, so it belongs at that place and size.
    expect(fit.rect.x).toBeCloseTo(0.04, 1);
    expect(fit.rect.y).toBeCloseTo(0.03, 1);
    expect(fit.rect.width).toBeCloseTo(0.92, 1);
    expect(fit.linesUp).toBe(true);
  });

  it("finds a result squeezed into a square, as some services return", () => {
    const fit = ResultFit.estimate(scene(W, H), reframed(scene(W, H), 48, 48, { x: 0, y: 0, width: 1, height: 1 }), noBrush);
    expect(fit.rect.width).toBeCloseTo(1, 1);
    expect(fit.rect.height).toBeCloseTo(1, 1);
    expect(fit.linesUp).toBe(true);
  });

  it("finds a result cropped to a square", () => {
    const side = H / W;
    const rect = { x: (1 - side) / 2, y: 0, width: side, height: 1 };
    const fit = ResultFit.estimate(scene(W, H), reframed(scene(W, H), 48, 48, rect), noBrush);
    expect(fit.rect.x).toBeCloseTo(rect.x, 1);
    expect(fit.rect.width).toBeCloseTo(rect.width, 1);
    expect(fit.linesUp).toBe(true);
  });

  it("ignores what changed inside the brush", () => {
    const result = scene(W, H);
    for (let i = 0, k = 0; i < brushed.length; i++, k += 4) if (brushed[i]! > 0.01) result.data[k] = result.data[k + 1] = result.data[k + 2] = 0;
    const fit = ResultFit.estimate(scene(W, H), result, brushed);
    expect(fit.error).toBeLessThan(1);
    expect(fit.rect.x).toBeCloseTo(0, 1);
  });

  it("accepts a result with another overall tone", () => {
    const warmer = scene(W, H);
    for (let i = 0; i < warmer.data.length; i += 4) for (let c = 0; c < 3; c++) warmer.data[i + c] = warmer.data[i + c]! * 0.7 + 40;
    const fit = ResultFit.estimate(scene(W, H), warmer, noBrush);
    expect(fit.agreement).toBeGreaterThan(0.9);
    expect(fit.linesUp).toBe(true);
  });

  it("accepts an unchanged plain picture, whose patterns say nothing", () => {
    const plain = () => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) });
    expect(ResultFit.estimate(plain(), plain(), noBrush).linesUp).toBe(true);
  });

  // Not sine patterns: a repeating pattern really does line up with itself when shifted.
  function patches(seed: number): RgbaImage {
    let state = seed * 2654435761 >>> 0;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const grid = Array.from({ length: 6 * 8 }, () => 40 + next() * 170);
    const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
    for (let y = 0, k = 0; y < H; y++) {
      for (let x = 0; x < W; x++, k += 4) {
        const v = grid[Math.floor(y / 8) * 8 + Math.floor(x / 8)]!;
        img.data[k] = img.data[k + 1] = img.data[k + 2] = v; img.data[k + 3] = 255;
      }
    }
    return img;
  }

  it("flags results of other pictures", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const fit = ResultFit.estimate(patches(seed), patches(seed + 100), noBrush);
      expect({ seed, linesUp: fit.linesUp, agreement: fit.agreement }).toEqual({ seed, linesUp: false, agreement: expect.any(Number) });
    }
  });

  it("still accepts those pictures against themselves, moved a little", () => {
    const fit = ResultFit.estimate(patches(5), reframed(patches(5), W, H, { x: 0.03, y: 0.02, width: 0.95, height: 0.96 }), noBrush);
    expect(fit.linesUp).toBe(true);
  });

  it("flags a flat grey result, close in brightness to anything", () => {
    const grey = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128) };
    expect(ResultFit.estimate(scene(W, H), grey, noBrush).linesUp).toBe(false);
  });
});

describe("ExifCarry", () => {
  function photo(orientation: number): Uint8Array {
    const encoded = jpeg.encode({ width: 16, height: 16, data: Buffer.from(scene(16, 16).data) }, 80).data;
    const exif = piexif.dump({
      "0th": { [piexif.ImageIFD.Orientation]: orientation, [piexif.ImageIFD.Make]: "Acme", [piexif.ImageIFD.Model]: "One" },
      Exif: { [piexif.ExifIFD.DateTimeOriginal]: "2024:07:14 09:00:00" },
      GPS: { [piexif.GPSIFD.GPSLatitudeRef]: "N", [piexif.GPSIFD.GPSLatitude]: [[32, 1], [5, 1], [0, 1]], [piexif.GPSIFD.GPSLongitudeRef]: "E", [piexif.GPSIFD.GPSLongitude]: [[34, 1], [47, 1], [0, 1]] },
      Interop: {},
      "1st": { [piexif.ImageIFD.Make]: "Acme" },
      thumbnail: String.fromCharCode(...encoded),
    });
    const out = piexif.insert(exif, String.fromCharCode(...encoded));
    return Uint8Array.from(out, (c) => c.charCodeAt(0));
  }
  const edited = () => new Uint8Array(jpeg.encode({ width: 32, height: 32, data: Buffer.from(scene(32, 32).data) }, 90).data);

  it("moves camera, time and GPS to the edited file, and sets it upright", () => {
    const buffer = ExifCarry.apply(edited(), photo(6)).buffer as ArrayBuffer;
    const tags = ExifReader.load(buffer);
    expect(tags["Make"]?.description).toBe("Acme");
    expect(tags["DateTimeOriginal"]?.description).toBe("2024:07:14 09:00:00");
    expect(ExifReader.load(buffer, { expanded: true }).gps?.Latitude).toBeCloseTo(32.083, 2);
    expect(tags["Orientation"]?.value).toBe(1);
  });

  it("drops the thumbnail, which would still show what was erased", () => {
    const out = ExifCarry.apply(edited(), photo(1));
    expect(ExifReader.load(out.buffer as ArrayBuffer)["Thumbnail"]).toBeUndefined();
    expect(piexif.load(String.fromCharCode(...out)).thumbnail ?? null).toBeNull();
  });

  it("keeps the edited pixels decodable at their size", () => {
    const decoded = jpeg.decode(ExifCarry.apply(edited(), photo(1)));
    expect([decoded.width, decoded.height]).toEqual([32, 32]);
  });

  it("works from only the start of a large original", () => {
    const full = photo(1);
    expect(ExifReader.load(ExifCarry.apply(edited(), full.slice(0, full.length - 40)).buffer as ArrayBuffer)["Make"]?.description).toBe("Acme");
  });

  it("reports a file it cannot read, instead of saving quietly without details", () => {
    expect(() => ExifCarry.apply(edited(), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(/not copied/);
  });
});

describe("Edit buttons", () => {
  it("never requires a brush: text alone is enough once it says what", () => {
    const erase = EditPrompt.preset("erase");
    expect(EditPrompt.ready(erase, erase.text, 0)).toBe(false); // "it" points at nothing
    expect(EditPrompt.needsTarget(erase, erase.text, 0)).toBe(true);
    expect(EditPrompt.ready(erase, erase.text, 1)).toBe(true);
    expect(EditPrompt.ready(erase, "Remove the crowd", 0)).toBe(true);
    expect(EditPrompt.needsTarget(erase, "Remove the crowd", 0)).toBe(false);
    for (const id of ["fix", "unblur", "enhance"] as const) expect(EditPrompt.ready(EditPrompt.preset(id), EditPrompt.preset(id).text, 0)).toBe(true);
    expect(EditPrompt.ready(EditPrompt.preset("add"), "Add: a dog", 0)).toBe(true);
    expect(EditPrompt.ready(EditPrompt.preset("replace"), "Replace the sky with: a sunset", 0)).toBe(true);
  });

  it("needs the user's own words where it says so", () => {
    const replace = EditPrompt.preset("replace");
    expect(EditPrompt.ready(replace, replace.text, 1)).toBe(false);
    expect(EditPrompt.ready(replace, `${replace.text}a red car`, 1)).toBe(true);
    expect(EditPrompt.ready(EditPrompt.preset("free"), "   ", 0)).toBe(false);
  });

  it("every button has a label and tooltip", () => {
    for (const p of EDIT_PRESETS) expect(p.label.length * p.title.length).toBeGreaterThan(0);
  });

  it("mentions the marking only when there is one", () => {
    expect(EditPrompt.compose("Remove it.", true)).toContain("magenta");
    expect(EditPrompt.compose("Make it warmer.", false)).not.toContain("magenta");
  });
});

describe("What the user brings back", () => {
  const transfer = (data: Record<string, string>, files: File[] = []) => ({ files: files as unknown as FileList, getData: (k: string) => data[k] ?? "" });

  it("recognises a site's blob address, and refuses it with what to do instead", async () => {
    const url = "blob:https://gemini.google.com/2ee27816-f4b8-4dc6-b912-edf99467482b";
    expect(ResultInput.read(transfer({ "text/plain": url }))).toEqual([{ kind: "url", url }]);
    expect(ResultInput.read(transfer({ "text/html": `<img src="${url}">` }))).toEqual([{ kind: "url", url }]);
    await expect(ResultInput.download(url)).rejects.toThrow("Download the picture there");
  });

  it("prefers a picture file", () => {
    const file = new File([new Uint8Array(1)], "a.png", { type: "image/png" });
    expect(ResultInput.read(transfer({ "text/plain": "https://x.test/a.png" }, [file]))).toEqual([{ kind: "image", blob: file }]);
  });

  it("ignores files that are not pictures", () => {
    const file = new File([new Uint8Array(1)], "a.txt", { type: "text/plain" });
    expect(ResultInput.read(transfer({}, [file]))).toEqual([]);
  });

  it("takes the address from a copied image's markup", () => {
    expect(ResultInput.read(transfer({ "text/html": `<meta><img alt="x" src="https://x.test/a.png?a=1&amp;b=2">` }))).toEqual([{ kind: "url", url: "https://x.test/a.png?a=1&b=2" }]);
  });

  it("takes an address typed as text, and skips comments in a link list", () => {
    expect(ResultInput.read(transfer({ "text/uri-list": "# a comment\nhttps://x.test/b.png" }))).toEqual([{ kind: "url", url: "https://x.test/b.png" }]);
    expect(ResultInput.read(transfer({ "text/plain": " https://x.test/c.png " }))).toEqual([{ kind: "url", url: "https://x.test/c.png" }]);
  });

  it("refuses plain text and insecure addresses", () => {
    expect(ResultInput.read(transfer({ "text/plain": "hello" }))).toEqual([]);
    expect(ResultInput.read(transfer({ "text/plain": "http://x.test/c.png" }))).toEqual([]);
  });
});

describe("Local engines", () => {
  afterEach(() => vi.unstubAllGlobals());
  const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const mask = new Blob([new Uint8Array([4, 5])], { type: "image/png" });
  const signal = new AbortController().signal;

  /** Records what is posted and answers with `reply`. */
  function server(reply: () => Response) {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
      return reply();
    });
    return posts;
  }

  /** Answers by address, and records what is posted. */
  function routes(table: Record<string, unknown>) {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (init.method === "POST") posts.push({ url, body: JSON.parse(init.body as string) });
      const path = new URL(url).pathname;
      return Response.json(table[path] ?? {});
    });
    return posts;
  }

  it("reads IOPaint's models, and knows which only fill a brushed area", async () => {
    routes({ "/api/v1/server-config": { modelInfos: [{ name: "lama", need_prompt: false, support_strength: false }, { name: "runwayml/x", need_prompt: true, support_strength: true }] }, "/api/v1/model": { name: "lama" } });
    expect(await new IoPaintEngine("http://a").models(signal)).toEqual({ current: "lama", list: [{ id: "lama", needsBrush: true, hasStrength: false }, { id: "runwayml/x", needsBrush: false, hasStrength: true }] });
  });

  it("switches IOPaint's model by name", async () => {
    const posts = routes({});
    await new IoPaintEngine("http://a").useModel("mat", signal);
    expect(posts).toEqual([{ url: "http://a/api/v1/model", body: { name: "mat" } }]);
  });

  it("refreshes, reads and switches the WebUI's checkpoints", async () => {
    const posts = routes({ "/sdapi/v1/sd-models": [{ title: "a.safetensors [1]" }], "/sdapi/v1/options": { sd_model_checkpoint: "a.safetensors [1]" } });
    const engine = new A1111Engine("http://a");
    expect(await engine.models(signal)).toEqual({ current: "a.safetensors [1]", list: [{ id: "a.safetensors [1]", needsBrush: false, hasStrength: true }] });
    expect(posts[0]!.url).toBe("http://a/sdapi/v1/refresh-checkpoints");
    await engine.useModel("b", signal);
    expect(posts[1]).toEqual({ url: "http://a/sdapi/v1/options", body: { sd_model_checkpoint: "b" } });
  });

  it("makes the commands a user runs, for the device they choose", () => {
    expect(EngineCommands.start("iopaint", "cuda", "lama", "http://127.0.0.1:8080")).toBe("iopaint start --model=lama --device=cuda --port=8080");
    expect(EngineCommands.start("iopaint", "cpu", "runwayml/stable-diffusion-inpainting", "http://127.0.0.1:9000")).toBe("iopaint start --model=runwayml/stable-diffusion-inpainting --device=cpu --port=9000");
    expect(EngineCommands.start("a1111", "cuda", "", "http://127.0.0.1:7860")).toBe("webui --api --port 7860");
    expect(EngineCommands.start("a1111", "cpu", "", "http://127.0.0.1:7860")).toContain("--use-cpu all");
    expect(EngineCommands.download("iopaint", "mat")).toBe("iopaint download --model=mat");
    expect(EngineCommands.download("a1111", "mat")).toBeNull();
  });

  it("refuses a model name that could do something else in a command", () => {
    for (const bad of ["lama; rm -rf /", "a b", "$(x)", "a&b", ""]) expect(() => EngineCommands.model(bad)).toThrow("A model name");
  });

  it("sends IOPaint the fields its server reads, and takes the bytes it answers with", async () => {
    const posts = server(() => new Response(new Blob([new Uint8Array([9])], { type: "image/png" })));
    const out = await new IoPaintEngine("http://127.0.0.1:8080").run({ image, mask, width: 10, height: 10, prompt: "x", strength: 0.5 }, signal);
    expect(posts[0]!.url).toBe("http://127.0.0.1:8080/api/v1/inpaint");
    expect(posts[0]!.body).toEqual({ image: btoa("\x01\x02\x03"), mask: btoa("\x04\x05"), prompt: "x", sd_strength: 0.5 });
    expect(out.size).toBe(1);
  });

  it("refuses IOPaint without a mask, since its call always takes one", async () => {
    await expect(new IoPaintEngine("http://a").run({ image, mask: null, width: 1, height: 1, prompt: "", strength: 1 }, signal)).rejects.toThrow("needs a mask");
  });

  it("sends the WebUI its fields in steps of 8 pixels, and decodes the base64 it answers with", async () => {
    const posts = server(() => Response.json({ images: [btoa("\x07")] }));
    const out = await new A1111Engine("http://127.0.0.1:7860").run({ image, mask: null, width: 1021, height: 765, prompt: "p", strength: 0.4 }, signal);
    expect(posts[0]!.url).toBe("http://127.0.0.1:7860/sdapi/v1/img2img");
    expect(posts[0]!.body).toEqual({ prompt: "p", init_images: [btoa("\x01\x02\x03")], width: 1024, height: 768, denoising_strength: 0.4 });
    expect([...new Uint8Array(await out.arrayBuffer())]).toEqual([7]);
  });

  it("says what to do when the engine is not running, and shows what it refused", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    await expect(new IoPaintEngine("http://a").run({ image, mask, width: 1, height: 1, prompt: "", strength: 1 }, signal)).rejects.toThrow("The engine could not be reached. Is it running?");
    server(() => new Response("bad size", { status: 400 }));
    await expect(new IoPaintEngine("http://a").run({ image, mask, width: 1, height: 1, prompt: "", strength: 1 }, signal)).rejects.toMatchObject({ message: "The engine refused the picture (400)", details: { detail: "bad size" } });
  });

  it("lists each protocol's call, a runtime, and only secure links", () => {
    for (const kind of ENGINE_KINDS) {
      expect(kind.help).toMatch(/POST \//);
      expect(kind.runtimes.length).toBeGreaterThan(0);
      for (const link of [...kind.runtimes, ...kind.models]) expect(link.url).toMatch(/^https:\/\//);
      expect(() => LocalAddress.parse(kind.address)).not.toThrow();
    }
  });

  it("keeps only the base of an address, and only http or https", () => {
    expect(LocalAddress.parse(" http://127.0.0.1:8080/app/ ")).toBe("http://127.0.0.1:8080");
    expect(() => LocalAddress.parse("file:///c:/x")).toThrow("http://");
    expect(() => LocalAddress.parse("nonsense")).toThrow("Not a web address");
  });
});

describe("Sign-in permission", () => {
  it("covers the domain Gemini's cookies are set on, since Chrome hides them otherwise", () => {
    expect(ServiceSignIn.origins()).toEqual(expect.arrayContaining(["https://gemini.google.com/*", "https://google.com/*", "https://chatgpt.com/*", "https://grok.com/*"]));
  });
});

describe("ServiceUrl", () => {
  it("accepts https only", () => {
    expect(ServiceUrl.parse(" https://aistudio.google.com/prompts?model=x ").host).toBe("aistudio.google.com");
    expect(() => ServiceUrl.parse("http://x.test")).toThrow(/https/);
    expect(() => ServiceUrl.parse("chatgpt")).toThrow(/web address/);
  });
});
