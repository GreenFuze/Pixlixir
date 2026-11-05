/**
 * Web worker hosting the panorama engine (Pyodide + OpenCV + OpenStitching).
 * Photos are decoded here and handed to Python once; every preview/full render
 * re-runs the stitch on the loaded photos. Progress is emitted as "progress" events.
 */

import type { loadPyodide as LoadPyodide } from "pyodide";
import DRIVER_SOURCE from "../../../imaging/panorama/pixlixir_stitch.py";
import { StitchRuntime, type OverlapGroups, type StitchOutput, type StitchSettings } from "../../../imaging/panorama/stitch-runtime.js";
import { ErrorCode, PixError } from "../../../shared/errors.js";
import { CanvasCodec } from "../canvas-codec.js";
import { WorkerRpcServer } from "../worker-rpc.js";

export type PanoramaWorkerRequest =
  | { id: number; op: "start" }
  | { id: number; op: "load"; key: number; bitmap: ImageBitmap }
  | { id: number; op: "remove"; key: number }
  | { id: number; op: "stitch"; keys: number[]; settings: StitchSettings; output: StitchOutput }
  | { id: number; op: "findGroups"; keys: number[] };

export interface PanoramaRender {
  image: Blob;
  fillOverlay: Blob | null;
  width: number;
  height: number;
  used: number[];
  dropped: number[];
  filledFraction: number;
  capped: boolean;
  scaleToFull: number;
  viewGain: number;
  shortSide: number;
  seconds: number;
  warnings: string[];
}

class PanoramaWorker {
  #runtime: Promise<StitchRuntime> | null = null;

  async handle(req: PanoramaWorkerRequest): Promise<unknown> {
    switch (req.op) {
      case "start":
        await this.runtime();
        return null;
      case "load":
        return this.load(req.key, req.bitmap);
      case "remove":
        (await this.runtime()).removeImage(req.key);
        return null;
      case "stitch":
        return this.stitch(req.keys, req.settings, req.output);
      case "findGroups":
        return (await this.runtime()).findGroups(req.keys) satisfies OverlapGroups;
    }
  }

  /** Starts the Python runtime once (the first call pays ~2–4 s). */
  private runtime(): Promise<StitchRuntime> {
    this.#runtime ??= (async () => {
      WorkerRpcServer.emit("progress", "Starting the panorama engine");
      const indexURL = new URL("./pyodide/", import.meta.url).href;
      const manifestUrl = new URL("vendor-manifest.json", indexURL).href;
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new PixError(ErrorCode.RuntimeUnavailable, "The panorama engine files are missing from the extension", { manifestUrl, status: res.status });
      const manifest = (await res.json()) as { packages: string[] };
      const { loadPyodide } = (await import(/* runtime URL, not bundled */ new URL("pyodide.mjs", indexURL).href)) as { loadPyodide: typeof LoadPyodide };
      return StitchRuntime.create(loadPyodide, { indexURL, packages: manifest.packages, driverSource: DRIVER_SOURCE }, (stage) => WorkerRpcServer.emit("progress", stage));
    })();
    this.#runtime.catch(() => (this.#runtime = null)); // allow a retry after a failed start
    return this.#runtime;
  }

  private async load(key: number, bitmap: ImageBitmap): Promise<{ width: number; height: number }> {
    const img = CanvasCodec.decode(bitmap);
    (await this.runtime()).setImage(key, img.data, img.width, img.height);
    return { width: img.width, height: img.height };
  }

  private async stitch(keys: number[], settings: StitchSettings, output: StitchOutput): Promise<PanoramaRender> {
    const r = (await this.runtime()).stitch(keys, settings, output);
    const render: PanoramaRender = {
      image: new Blob([r.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      fillOverlay: r.fillOverlayPng ? new Blob([r.fillOverlayPng as Uint8Array<ArrayBuffer>], { type: "image/png" }) : null,
      width: r.width,
      height: r.height,
      used: r.used,
      dropped: r.dropped,
      filledFraction: r.filledFraction,
      capped: r.capped,
      scaleToFull: r.scaleToFull,
      viewGain: r.viewGain,
      shortSide: r.shortSide,
      seconds: r.seconds,
      warnings: r.warnings,
    };
    return render;
  }
}

const worker = new PanoramaWorker();
WorkerRpcServer.serve<PanoramaWorkerRequest>((req) => worker.handle(req), "Panorama worker failed");
