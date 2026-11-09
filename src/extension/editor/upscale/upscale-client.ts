/** Promise-based client for upscale-worker.ts. Construct to spawn; dispose() to terminate. */

import { WorkerRpcClient } from "../worker-rpc.js";
import type { PreviewRequest, PreviewResult, RunRequest, UpscaleWorkerRequest } from "./upscale-worker.js";

export class UpscaleWorkerClient extends WorkerRpcClient<UpscaleWorkerRequest> {
  constructor(onProgress: (done: number, total: number) => void) {
    super(new URL("./upscale-worker.js", import.meta.url), (e) => {
      if (e.event === "progress") {
        const p = e.data as { done: number; total: number };
        onProgress(p.done, p.total);
      }
    });
  }

  /** Hands the photo to the worker; the bitmap is moved, not copied. */
  load(bitmap: ImageBitmap): Promise<{ width: number; height: number }> {
    return this.request({ op: "load", bitmap }, [bitmap]);
  }

  gpuAvailable(): Promise<boolean> {
    return this.request({ op: "gpu" });
  }

  preview(req: PreviewRequest): Promise<PreviewResult> {
    return this.request({ op: "preview", ...req });
  }

  run(req: RunRequest): Promise<{ bitmap: ImageBitmap; ms: number }> {
    return this.request({ op: "run", ...req });
  }
}
