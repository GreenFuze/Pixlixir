/** Promise-based client for panorama-worker.ts. Construct to spawn; dispose() to terminate (also cancels). */

import type { OverlapGroups, StitchOutput, StitchSettings } from "../../../imaging/panorama/stitch-runtime.js";
import { WorkerRpcClient } from "../worker-rpc.js";
import type { PanoramaRender, PanoramaWorkerRequest } from "./panorama-worker.js";

export class PanoramaWorkerClient extends WorkerRpcClient<PanoramaWorkerRequest> {
  constructor(onProgress: (stage: string) => void) {
    super(new URL("./panorama-worker.js", import.meta.url), (ev) => {
      if (ev.event === "progress") onProgress(String(ev.data));
    });
  }

  start(): Promise<null> {
    return this.request({ op: "start" });
  }

  load(key: number, bitmap: ImageBitmap): Promise<{ width: number; height: number }> {
    return this.request({ op: "load", key, bitmap }, [bitmap]);
  }

  remove(key: number): Promise<null> {
    return this.request({ op: "remove", key });
  }

  stitch(keys: number[], settings: StitchSettings, output: StitchOutput): Promise<PanoramaRender> {
    return this.request({ op: "stitch", keys, settings, output });
  }

  /** Which loaded photos overlap into panoramas (keys in capture order). */
  findGroups(keys: number[]): Promise<OverlapGroups> {
    return this.request({ op: "findGroups", keys });
  }
}
