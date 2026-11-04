/**
 * Live protocol probe — reproducible evidence for docs/feasibility.
 *
 * Build: npm run build:probe   → dist-probe/probe.js
 * Use:   paste dist-probe/probe.js into the DevTools console of a signed-in
 *        photos.google.com tab, then run:
 *          await PixlixirProbe.readOnly("<mediaKey of any own photo>")
 *          await PixlixirProbe.uploadRoundTrip()   // creates ONE synthetic item; trash it afterwards
 * Prints shapes and pass/fail only — never tokens or personal data.
 */

import { LiveWebAdapter } from "../../src/gphotos/live-adapter.js";
import { WizSessionReader } from "../../src/gphotos/protocol/session.js";

class PixlixirProbe {
  static adapter(): LiveWebAdapter {
    const session = new WizSessionReader().read(document, location.pathname);
    return new LiveWebAdapter(session, location.origin, () => location.pathname, (i, init) => fetch(i, init));
  }

  static async readOnly(mediaKey: string): Promise<Record<string, unknown>> {
    const a = PixlixirProbe.adapter();
    const item = await a.getItem(mediaKey);
    const res = await fetch(`${item.baseUrl}=d`, { credentials: "omit" });
    const blob = await res.blob();
    return { account: a.account.email.replace(/^(.).*(@.*)$/, "$1***$2"), type: item.type, dims: `${item.width}x${item.height}`, hasFileName: item.fileName !== null, originalHttp: res.status, originalBytes: blob.size, originalType: blob.type };
  }

  static async uploadRoundTrip(): Promise<Record<string, unknown>> {
    // Paragraph: synthetic image, never personal content.
    const canvas = document.createElement("canvas");
    canvas.width = 480; canvas.height = 320;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#3b2a7a"; g.fillRect(0, 0, 480, 320);
    g.fillStyle = "#fff"; g.font = "bold 26px sans-serif"; g.fillText("Pixlixir live probe", 40, 150);
    g.font = "16px sans-serif"; g.fillText(`synthetic · ${new Date().toISOString()} · safe to delete`, 40, 190);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/jpeg", 0.9));

    // Paragraph: upload with a fixed capture date, then read it back.
    const takenAtMs = Date.UTC(2001, 1, 3, 10, 0, 0);
    const a = PixlixirProbe.adapter();
    const created = await a.uploadPhoto(new Uint8Array(await blob.arrayBuffer()), "pixlixir-live-probe.jpg", { takenAtMs, timezoneOffsetMs: 7_200_000 });
    const back = await a.getItem(created.ref.mediaKey);
    return { uploaded: true, webUrl: created.webUrl, dims: `${back.width}x${back.height}`, dateSetOk: back.takenAtMs === takenAtMs, readBackTakenAt: new Date(back.takenAtMs).toISOString(), tzOk: back.timezoneOffsetMs === 7_200_000, fileName: back.fileName };
  }
}

(globalThis as unknown as { PixlixirProbe: typeof PixlixirProbe }).PixlixirProbe = PixlixirProbe;
