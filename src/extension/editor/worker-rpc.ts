/**
 * Minimal typed request/response over postMessage, shared by every editor worker.
 *
 * Worker side: WorkerRpcServer.serve(handler) answers {id, op, ...} requests with
 * {id, ok, value|error}; workers may also post {event} messages (e.g. progress).
 * Page side: subclass WorkerRpcClient (constructor spawns the worker, dispose() terminates it).
 */

import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";

export type RpcResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: SerializedError };
export type RpcEvent = { event: string; data: unknown };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class WorkerRpcServer {
  /** Answers requests with `handler`; results may carry transferables via WorkerRpcServer.transfer(). */
  static serve<Req extends { id: number }>(handler: (req: Req) => unknown, failureMessage: string): void {
    self.addEventListener("message", (ev: MessageEvent<Req>) => {
      const req = ev.data;
      Promise.resolve()
        .then(() => handler(req))
        .then(
          (value) => {
            const transfer = WorkerRpcServer.#transfers.get(value as object) ?? [];
            WorkerRpcServer.#transfers.delete(value as object);
            self.postMessage({ id: req.id, ok: true, value } satisfies RpcResponse, { transfer });
          },
          (err: unknown) => {
            const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, failureMessage);
            self.postMessage({ id: req.id, ok: false, error: e.toJSON() } satisfies RpcResponse);
          },
        );
    });
  }

  static #transfers = new WeakMap<object, Transferable[]>();

  /** Marks buffers inside a result to be transferred (not copied) to the page. */
  static transfer<T extends object>(value: T, transferables: Transferable[]): T {
    WorkerRpcServer.#transfers.set(value, transferables);
    return value;
  }

  static emit(event: string, data: unknown): void {
    self.postMessage({ event, data } satisfies RpcEvent);
  }
}

export abstract class WorkerRpcClient<Req extends { id: number; op: string }> {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: PixError) => void }>();
  #nextId = 1;

  protected constructor(url: URL, onEvent: (event: RpcEvent) => void = () => {}) {
    this.#worker = new Worker(url, { type: "module" });
    this.#worker.addEventListener("message", (ev: MessageEvent<RpcResponse | RpcEvent>) => {
      const msg = ev.data;
      if ("event" in msg) {
        onEvent(msg);
        return;
      }
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(PixError.fromSerialized(msg.error));
    });
    this.#worker.addEventListener("error", (ev) => this.failAll(new PixError(ErrorCode.Internal, `Worker crashed: ${ev.message || "unknown error"}`, { url: url.href })));
  }

  dispose(): void {
    this.#worker.terminate();
    this.failAll(new PixError(ErrorCode.Cancelled, "The operation was cancelled"));
  }

  protected request<T>(req: DistributiveOmit<Req, "id">, transfer: Transferable[] = []): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#worker.postMessage({ ...req, id }, transfer);
    });
  }

  private failAll(error: PixError): void {
    for (const p of this.#pending.values()) p.reject(error);
    this.#pending.clear();
  }
}
