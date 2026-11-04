/** Promise-based client for split-worker.ts. Construct to spawn; dispose() to terminate. */

import type { Quad } from "../../imaging/geometry.js";
import type { DetectedPrint } from "../../imaging/split/detector.js";
import { PixError } from "../../shared/errors.js";
import type { WorkerRequest, WorkerResponse } from "./split-worker.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class SplitWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: PixError) => void }>();
  #nextId = 1;

  constructor() {
    this.#worker = new Worker(new URL("./split-worker.js", import.meta.url), { type: "module" });
    this.#worker.addEventListener("message", (ev: MessageEvent<WorkerResponse>) => {
      const p = this.#pending.get(ev.data.id);
      if (!p) return;
      this.#pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.value);
      else p.reject(PixError.fromSerialized(ev.data.error));
    });
  }

  dispose(): void {
    this.#worker.terminate();
    this.#pending.clear();
  }

  load(bitmap: ImageBitmap): Promise<{ width: number; height: number }> {
    return this.request({ op: "load", bitmap }, [bitmap]) as Promise<{ width: number; height: number }>;
  }

  detect(): Promise<DetectedPrint[]> {
    return this.request({ op: "detect" }) as Promise<DetectedPrint[]>;
  }

  render(quad: Quad, rotation: number, preview: boolean): Promise<Blob> {
    return this.request({ op: "render", quad, rotation, preview }) as Promise<Blob>;
  }

  private request(req: DistributiveOmit<WorkerRequest, "id">, transfer: Transferable[] = []): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...req, id }, transfer);
    });
  }
}
