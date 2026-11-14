/**
 * The link between Pixlixir and its Local API helper (ADR-0012), held by the service worker.
 *
 * Switching the API on asks Chrome to start the helper through native messaging; Chrome joins the
 * helper's standard input and output to a port here. Each message is JSON:
 *   helper -> Pixlixir: {type:"hello", version} | {type:"listening", port} | {type:"listenFailed", code, message}
 *                       | {type:"request", id, op, params}
 *   Pixlixir -> helper: {type:"config", port, key, pixlixirVersion}
 *                       | {type:"response", id, ok:true, json} | {type:"response", id, ok:false, error}
 *                       | {type:"response", id, ok:true, binary:{mimeType, fileName, size}} then {type:"chunk", id, seq, data, last}
 * Switching off closes the port; the helper then exits. An open port keeps the service worker awake.
 */

import { z } from "zod";
import { Base64 } from "../../shared/codec.js";
import { ApiError } from "./api-types.js";
import type { LocalApiService } from "./api-service.js";

export interface ApiConfig {
  enabled: boolean;
  port: number;
  key: string;
}

export type ApiRunState = "off" | "starting" | "running" | "failed";

export interface ApiState {
  config: ApiConfig;
  state: ApiRunState;
  /** Why it is not running, in words for people, and a code. */
  problem: { code: string; message: string } | null;
  helperVersion: string | null;
  served: number;
}

/** The API's settings, kept for the whole browser (not per account). */
export class ApiConfigStore {
  static readonly KEY = "pixlixir.localApi";
  static readonly DEFAULT_PORT = 8765;

  async load(): Promise<ApiConfig> {
    const got = (await chrome.storage.local.get(ApiConfigStore.KEY))[ApiConfigStore.KEY] as Partial<ApiConfig> | undefined;
    if (got?.key && typeof got.port === "number") return { enabled: got.enabled === true, port: got.port, key: got.key };
    const fresh: ApiConfig = { enabled: false, port: ApiConfigStore.DEFAULT_PORT, key: ApiConfigStore.newKey() };
    await this.save(fresh);
    return fresh;
  }

  async save(config: ApiConfig): Promise<void> {
    await chrome.storage.local.set({ [ApiConfigStore.KEY]: config });
  }

  /** 32 random bytes, base64url. */
  static newKey(): string {
    return Base64.encode(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
}

const FromHelper = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.string().max(40) }),
  z.object({ type: z.literal("listening"), port: z.number().int() }),
  z.object({ type: z.literal("listenFailed"), code: z.string().max(40), message: z.string().max(500) }),
  z.object({ type: z.literal("request"), id: z.number().int().nonnegative(), op: z.string().max(40), params: z.record(z.string(), z.string().max(4096)) }),
]);

export class NativeApiBridge {
  static readonly HOST = "com.greenfuze.pixlixir";
  /** Raw bytes per chunk of a file; base64 keeps each message well under Chrome's 64 MB limit. */
  static readonly CHUNK_BYTES = 4 * 1024 * 1024;

  #port: chrome.runtime.Port | null = null;
  #state: ApiState | null = null;
  #stopping = false;

  constructor(private readonly store: ApiConfigStore, private readonly service: LocalApiService, private readonly pixlixirVersion: string) {}

  /** The helper's version, for the status call. */
  get helperVersion(): string | null {
    return this.#state?.helperVersion ?? null;
  }

  async state(): Promise<ApiState> {
    return this.#state ?? { config: await this.store.load(), state: "off", problem: null, helperVersion: null, served: 0 };
  }

  /** Starts the helper if the API is switched on and it is not running. Safe to call often. */
  async ensure(): Promise<void> {
    const config = await this.store.load();
    if (!config.enabled || this.#port) return;
    if (!(await chrome.permissions.contains({ permissions: ["nativeMessaging"] }))) {
      this.#state = { config, state: "failed", problem: { code: "NO_PERMISSION", message: "Switch the API off and on again to allow it." }, helperVersion: null, served: 0 };
      return;
    }
    this.connect(config);
  }

  async setEnabled(enabled: boolean): Promise<ApiState> {
    const config = { ...(await this.store.load()), enabled };
    await this.store.save(config);
    if (enabled) await this.restart(config);
    else this.disconnect(config);
    return this.state();
  }

  async setPort(port: number): Promise<ApiState> {
    const config = { ...(await this.store.load()), port };
    await this.store.save(config);
    if (config.enabled) await this.restart(config);
    else this.#state = this.#state && { ...this.#state, config };
    return this.state();
  }

  /** A new key; the old one stops working at once. */
  async newKey(): Promise<ApiState> {
    const config = { ...(await this.store.load()), key: ApiConfigStore.newKey() };
    await this.store.save(config);
    if (config.enabled) await this.restart(config);
    else this.#state = this.#state && { ...this.#state, config };
    return this.state();
  }

  private async restart(config: ApiConfig): Promise<void> {
    this.disconnect(config);
    await this.ensure();
  }

  private connect(config: ApiConfig): void {
    // Paragraph: Chrome starts the helper; anything it cannot do arrives as a disconnect.
    this.#stopping = false;
    this.#state = { config, state: "starting", problem: null, helperVersion: null, served: this.#state?.served ?? 0 };
    const port = chrome.runtime.connectNative(NativeApiBridge.HOST);
    this.#port = port;
    port.onMessage.addListener((raw: unknown) => void this.onMessage(port, raw));
    port.onDisconnect.addListener(() => this.onDisconnect(port));

    // Paragraph: tell it where to listen and which key to ask for.
    port.postMessage({ type: "config", port: config.port, key: config.key, pixlixirVersion: this.pixlixirVersion });
  }

  private disconnect(config: ApiConfig): void {
    this.#stopping = true;
    this.#port?.disconnect();
    this.#port = null;
    this.#state = { config, state: "off", problem: null, helperVersion: null, served: this.#state?.served ?? 0 };
  }

  private onDisconnect(port: chrome.runtime.Port): void {
    if (this.#port !== port) return;
    this.#port = null;
    const why = chrome.runtime.lastError?.message ?? "";
    if (this.#stopping || !this.#state) return;
    const missing = /not found|not registered|forbidden/i.test(why);
    this.#state = { ...this.#state, state: "failed", helperVersion: null, problem: missing ? { code: "HELPER_NOT_INSTALLED", message: "The helper is not installed. Run the install command." } : this.#state.problem ?? { code: "HELPER_STOPPED", message: why || "The helper stopped." } };
  }

  private async onMessage(port: chrome.runtime.Port, raw: unknown): Promise<void> {
    const parsed = FromHelper.safeParse(raw);
    if (!parsed.success || !this.#state) {
      console.error("[pixlixir] unexpected message from the API helper", parsed.success ? "no state" : parsed.error.issues.slice(0, 3));
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case "hello":
        this.#state = { ...this.#state, helperVersion: msg.version };
        return;
      case "listening":
        this.#state = { ...this.#state, state: "running", problem: null };
        return;
      case "listenFailed":
        this.#state = { ...this.#state, state: "failed", problem: { code: msg.code, message: msg.message } };
        return;
      case "request":
        await this.answer(port, msg.id, { op: msg.op, params: msg.params });
        return;
    }
  }

  /** Runs one request and sends the answer back, a file in pieces. */
  private async answer(port: chrome.runtime.Port, id: number, request: unknown): Promise<void> {
    try {
      const result = await this.service.handle(request);
      if (this.#state) this.#state = { ...this.#state, served: this.#state.served + 1 };
      if (result.kind === "json") {
        port.postMessage({ type: "response", id, ok: true, json: result.body });
        return;
      }
      port.postMessage({ type: "response", id, ok: true, binary: { mimeType: result.mimeType, fileName: result.fileName, size: result.bytes.byteLength } });
      const total = Math.max(1, Math.ceil(result.bytes.byteLength / NativeApiBridge.CHUNK_BYTES));
      for (let seq = 0; seq < total; seq++) {
        const part = result.bytes.subarray(seq * NativeApiBridge.CHUNK_BYTES, (seq + 1) * NativeApiBridge.CHUNK_BYTES);
        port.postMessage({ type: "chunk", id, seq, data: Base64.encode(part), last: seq === total - 1 });
      }
    } catch (err) {
      const e = ApiError.from(err);
      if (e.code === "INTERNAL") console.error("[pixlixir] Local API request failed", e.toJSON());
      try {
        port.postMessage({ type: "response", id, ok: false, error: e.toJSON() });
      } catch (sendErr) {
        console.error("[pixlixir] could not answer the API helper (disconnected?)", sendErr);
      }
    }
  }
}
