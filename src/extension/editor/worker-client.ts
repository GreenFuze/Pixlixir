/** Promise-based client for split-worker.ts. Construct to spawn; dispose() to terminate. */

import type { DetectedPrint } from "../../imaging/split/detector.js";
import type { RenderRequest, RenderResult, WorkerRequest } from "./split-worker.js";
import { WorkerRpcClient } from "./worker-rpc.js";

export class SplitWorkerClient extends WorkerRpcClient<WorkerRequest> {
  constructor() {
    super(new URL("./split-worker.js", import.meta.url));
  }

  load(bitmap: ImageBitmap): Promise<{ width: number; height: number; lightingAvailable: boolean }> {
    return this.request({ op: "load", bitmap }, [bitmap]);
  }

  detect(): Promise<DetectedPrint[]> {
    return this.request({ op: "detect" });
  }

  render(req: RenderRequest): Promise<RenderResult> {
    return this.request({ op: "render", ...req });
  }
}
