/**
 * A fake photos.google.com behind Playwright routes: session page (with a strict CSP),
 * batchexecute RPCs, image renditions and uploads. The extension under test is the real
 * build; only Google's servers are replaced. Everything here is synthetic.
 */

import type { BrowserContext, Page, Route } from "playwright";

export interface FakePhoto {
  mediaKey: string;
  dedupKey: string;
  takenAtMs: number;
  jpeg: Buffer;
  width: number;
  height: number;
}

export const FAKE_EMAIL = "e2e@example.com";
const PREFIX = "/_/PhotosUi/";
const CORS = { "access-control-allow-origin": "https://photos.google.com", "access-control-allow-credentials": "true", "access-control-expose-headers": "x-goog-upload-url, x-goog-upload-status" };
const ALBUM = "AF1QipFAKEALBUM00001";

export class FakePhotos {
  readonly uploads: { fileName: string; bytes: Buffer }[] = [];
  readonly calls: { rpc: string; payload: unknown }[] = [];
  #pending: { fileName: string } | null = null;

  constructor(private readonly photos: FakePhoto[]) {}

  async install(context: BrowserContext): Promise<void> {
    await context.route("https://photos.google.com/**", (route) => this.photosOrigin(route));
    await context.route("https://photos.fife.usercontent.google.com/**", (route) => this.rendition(route));
  }

  private byBase(url: string): FakePhoto | undefined {
    return this.photos.find((p) => url.includes(`/fake/${p.mediaKey}`));
  }

  /** Image downloads so far, to prove that later scans do not repeat them. */
  renditions = 0;

  private async rendition(route: Route): Promise<void> {
    this.renditions++;
    const photo = this.byBase(route.request().url());
    if (!photo) return route.fulfill({ status: 404, headers: CORS });
    return route.fulfill({ status: 200, contentType: "image/jpeg", headers: CORS, body: photo.jpeg });
  }

  private async photosOrigin(route: Route): Promise<void> {
    const url = new URL(route.request().url());

    // Paragraph: batchexecute RPCs.
    if (url.pathname === `${PREFIX}data/batchexecute`) {
      const rpc = url.searchParams.get("rpcids")!;
      const form = new URLSearchParams(route.request().postData() ?? "");
      const payload = JSON.parse((JSON.parse(form.get("f.req")!) as unknown[][][])[0]![0]![1] as string) as unknown;
      this.calls.push({ rpc, payload });
      const inner = JSON.stringify(this.answer(rpc, payload));
      const body = `)]}'\n\n100\n${JSON.stringify([["wrb.fr", rpc, inner, null, null, null, "generic"]])}\n`;
      return route.fulfill({ status: 200, contentType: "application/json", body });
    }

    // Paragraph: resumable upload.
    if (url.pathname === "/_/upload/uploadmedia/interactive") {
      const headers = route.request().headers();
      this.#pending = { fileName: headers["x-goog-upload-file-name"] ?? "unknown" };
      return route.fulfill({ status: 200, headers: { ...CORS, "x-goog-upload-url": "https://photos.google.com/_/upload/fake-session" } });
    }
    if (url.pathname === "/_/upload/fake-session") {
      this.uploads.push({ fileName: this.#pending!.fileName, bytes: route.request().postDataBuffer() ?? Buffer.alloc(0) });
      return route.fulfill({ status: 200, headers: { ...CORS, "x-goog-upload-status": "final" }, body: "FAKE_UPLOAD_TOKEN" });
    }

    // Paragraph: the app page, with a CSP that forbids frames: the extension's modal must still work.
    const wiz = { SNlM0e: "fake-xsrf", FdrFJe: "1", cfb2h: "fake-build", eptZe: PREFIX, oPEP7c: FAKE_EMAIL, S06Grb: "123" };
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: { "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; frame-src 'none'" },
      body: `<!doctype html><html><head><title>Fake Photos</title><script>window.WIZ_global_data = ${JSON.stringify(wiz)};</script></head><body><main>fake library</main></body></html>`,
    });
  }

  private row(p: FakePhoto): unknown[] {
    return [p.mediaKey, [`https://photos.fife.usercontent.google.com/pw/fake/${p.mediaKey}`, p.width, p.height], p.takenAtMs, p.dedupKey, 7_200_000, p.takenAtMs, null, [[1]], 0, null, null, null, { "129168200": [[null], [[488584000, 22945000], null, null, true, [], 1]] }];
  }

  private answer(rpc: string, payload: unknown): unknown {
    const key = (payload as unknown[])[0] as string;
    const photo = this.photos.find((p) => p.mediaKey === key);
    switch (rpc) {
      case "lcxiM":
        return [[...this.photos].sort((a, b) => b.takenAtMs - a.takenAtMs).map((p) => this.row(p)), null, "0"];
      case "VrseUb":
        return [this.row(photo!)];
      case "fDcn4b": {
        const e: unknown[] = new Array(33).fill(null);
        e[0] = photo!.mediaKey;
        e[1] = "Harbour, morning";
        e[2] = `${photo!.mediaKey}.jpg`;
        e[5] = photo!.jpeg.length;
        e[11] = photo!.dedupKey;
        e[13] = [[488584000, 22945000], true, []];
        e[19] = [[ALBUM, [], null, null, null, null, ["owner"], [[1]], { "72930366": [1, "Fake trip", [], 2, null] }]];
        e[23] = ["FakeCam", "One"];
        return [e];
      }
      case "Z5xsfc":
        return [[[ALBUM, [], null, null, null, null, ["owner"], [[1]], { "72930366": [1, "Fake trip", [], 2, null] }]], null];
      case "mdpdU":
        return [[[null, [`AF1QipUPLOADED${this.uploads.length}000`, ["https://photos.fife.usercontent.google.com/pw/fake/up", 100, 100], 0, `dedupUPLOADED${this.uploads.length}`]]]];
      default:
        return [];
    }
  }
}

/** Overlapping synthetic shots, drawn and JPEG-encoded by the browser (nothing personal, nothing checked in). */
export async function makeOverlappingShots(page: Page, count: number): Promise<Buffer[]> {
  const encoded = await page.evaluate(async (n: number) => {
    // Paragraph: one feature-rich scene.
    const shotW = 800, h = 600, step = 500, sceneW = shotW + step * (n - 1);
    const scene = new OffscreenCanvas(sceneW, h);
    const g = scene.getContext("2d")!;
    let s = 42;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
    g.fillStyle = "#6b8cae";
    g.fillRect(0, 0, sceneW, h);
    for (let i = 0; i < (sceneW * h) / 700; i++) {
      g.fillStyle = `rgb(${rnd() * 255},${rnd() * 255},${rnd() * 255})`;
      const r = 4 + rnd() * 18;
      g.fillRect(rnd() * sceneW, rnd() * h, r, r * (0.5 + rnd()));
    }

    // Paragraph: crop the shots.
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = new OffscreenCanvas(shotW, h);
      c.getContext("2d")!.drawImage(scene, -i * step, 0);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.9 })).arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      out.push(btoa(bin));
    }
    return out;
  }, count);
  return encoded.map((b) => Buffer.from(b, "base64"));
}
