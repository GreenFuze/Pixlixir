/**
 * Image engines the user runs on their own computer and configures in Settings. Nothing is bundled.
 * The photo crop and exact brush go straight to the address the user gave. API facts: ADR-0009.
 */

import { Base64 } from "../../../shared/codec.js";
import { ErrorCode, PixError } from "../../../shared/errors.js";

export type EngineKind = "iopaint" | "a1111";

export interface EngineLink {
  name: string;
  url: string;
  title: string;
}

export interface EngineKindInfo {
  id: EngineKind;
  /** The protocol's name, as listed in Settings. */
  label: string;
  /** The call and what it can do. */
  help: string;
  address: string;
  /** How models are added and deleted, since the server has no call for it. */
  modelFiles: string;
  runtimes: readonly EngineLink[];
  models: readonly EngineLink[];
}

/** Facts read from each project's own pages, 2026-11-06. Only general-purpose tools are listed. */
export const ENGINE_KINDS: readonly EngineKindInfo[] = [
  {
    id: "iopaint",
    label: "IOPaint",
    help: "POST /api/v1/inpaint. Fills the brushed area, so it needs a brush. Text only works with diffusion models. Start it with: iopaint start --model=lama --device=cpu --port=8080",
    address: "http://127.0.0.1:8080",
    modelFiles: "Download adds a model. IOPaint cannot delete one: delete its file from .cache/torch/hub/checkpoints in your user folder, or from .cache/huggingface/hub for diffusion models, then press Refresh in Edit",
    runtimes: [{ name: "IOPaint", url: "https://github.com/Sanster/IOPaint", title: "Apache-2.0. Archived in 2025: it still installs, with no further updates. Install with: pip3 install iopaint" }],
    models: [
      { name: "All its models", url: "https://www.iopaint.com/models", title: "Erase models such as LaMa, MAT and MIGAN, and diffusion models that follow text" },
      { name: "LaMa", url: "https://www.iopaint.com/models/erase/lama", title: "Erases what is brushed. Downloaded when IOPaint first starts with it" },
    ],
  },
  {
    id: "a1111",
    label: "Stable Diffusion WebUI",
    help: "POST /sdapi/v1/img2img. Works with or without a brush, and follows text. Start the runtime with --api",
    address: "http://127.0.0.1:7860",
    modelFiles: "A model is a file. Put it in the runtime's models/Stable-diffusion folder, or delete it there, then press Refresh in Edit",
    runtimes: [
      { name: "SD.Next", url: "https://github.com/vladmandic/sdnext", title: "Apache-2.0. Maintained. Serves this call; its fields were not compared" },
      { name: "reForge", url: "https://github.com/Panchovix/stable-diffusion-webui-reForge", title: "AGPL-3.0. Maintained. Serves this call" },
      { name: "Forge", url: "https://github.com/lllyasviel/stable-diffusion-webui-forge", title: "AGPL-3.0. Serves this call. Last changed in 2025" },
      { name: "AUTOMATIC1111", url: "https://github.com/AUTOMATIC1111/stable-diffusion-webui", title: "AGPL-3.0. The original. Last changed in 2024" },
    ],
    models: [{ name: "SDXL inpainting", url: "https://huggingface.co/diffusers/stable-diffusion-xl-1.0-inpainting-0.1", title: "OpenRAIL++-M license. Its card says it is meant for research. Check the terms before using it" }],
  },
];

export interface EngineRequest {
  /** The picture without any marking. */
  image: Blob;
  /** White where the brush is, black elsewhere, the same size as the image. Null only for an engine that does not need one. */
  mask: Blob | null;
  width: number;
  height: number;
  prompt: string;
  /** How far it may stray from the picture, 0 to 1. */
  strength: number;
}

/** A model on the user's server. */
export interface EngineModel {
  id: string;
  /** It only fills a brushed area from its surroundings, and cannot read text. */
  needsBrush: boolean;
  /** How far it may stray can be set. */
  hasStrength: boolean;
}

export interface EngineModels {
  list: EngineModel[];
  /** Null when the server does not say. */
  current: string | null;
}

const base64 = async (blob: Blob): Promise<string> => Base64.encode(new Uint8Array(await blob.arrayBuffer()));

export abstract class LocalEngine {
  /** Until its models are known, whether to assume it can only work on a brushed area. */
  abstract readonly needsBrush: boolean;
  /** Its call always takes a mask, so text alone sends one covering the whole picture. */
  abstract readonly alwaysNeedsMask: boolean;

  constructor(protected readonly address: string) {}

  abstract run(request: EngineRequest, signal: AbortSignal): Promise<Blob>;

  /** The models on the server, read again from its disk. */
  abstract models(signal: AbortSignal): Promise<EngineModels>;

  /** Makes this the server's current model. It can take a while. */
  abstract useModel(id: string, signal: AbortSignal): Promise<void>;

  protected post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return this.send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }, signal);
  }

  protected async getJson<T>(path: string, signal: AbortSignal): Promise<T> {
    return (await (await this.send(path, { method: "GET", signal }, signal)).json()) as T;
  }

  /** Says what to do when the engine cannot be reached, since it is the user's own server. */
  private async send(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.address}${path}`, init);
    } catch (err) {
      if (signal.aborted) throw new PixError(ErrorCode.Cancelled, "Stopped");
      throw PixError.wrap(err, ErrorCode.LocalEngineFailed, "The engine could not be reached. Is it running?", { address: this.address });
    }
    if (!response.ok) throw new PixError(ErrorCode.LocalEngineFailed, `The engine refused the picture (${response.status})`, { address: this.address, status: response.status, detail: (await response.text()).slice(0, 200) });
    return response;
  }

  /** The engine for this entry. Its address has been checked by LocalAddress. */
  static create(kind: EngineKind, address: string): LocalEngine {
    return kind === "iopaint" ? new IoPaintEngine(address) : new A1111Engine(address);
  }
}

/** POST /api/v1/inpaint: JSON with base64 image and mask; answers with the image's bytes. */
export class IoPaintEngine extends LocalEngine {
  readonly needsBrush = true;
  readonly alwaysNeedsMask = true;

  async run(request: EngineRequest, signal: AbortSignal): Promise<Blob> {
    if (!request.mask) throw new PixError(ErrorCode.LocalEngineFailed, "IOPaint needs a mask");
    const response = await this.post("/api/v1/inpaint", { image: await base64(request.image), mask: await base64(request.mask), prompt: request.prompt, sd_strength: request.strength }, signal);
    return response.blob();
  }

  async models(signal: AbortSignal): Promise<EngineModels> {
    const [config, current] = await Promise.all([
      this.getJson<{ modelInfos?: { name: string; need_prompt?: boolean; support_strength?: boolean }[] }>("/api/v1/server-config", signal),
      this.getJson<{ name?: string }>("/api/v1/model", signal),
    ]);
    return { current: current.name ?? null, list: (config.modelInfos ?? []).map((m) => ({ id: m.name, needsBrush: m.need_prompt !== true, hasStrength: m.support_strength === true })) };
  }

  async useModel(id: string, signal: AbortSignal): Promise<void> {
    await this.post("/api/v1/model", { name: id }, signal);
  }
}

/** POST /sdapi/v1/img2img: JSON with base64 images; answers with base64 images. */
export class A1111Engine extends LocalEngine {
  readonly needsBrush = false;
  readonly alwaysNeedsMask = false;
  /** The engine works in steps of 8 pixels. */
  private static readonly STEP = 8;

  async run(request: EngineRequest, signal: AbortSignal): Promise<Blob> {
    const size = (side: number) => Math.max(A1111Engine.STEP, Math.round(side / A1111Engine.STEP) * A1111Engine.STEP);
    const body = {
      prompt: request.prompt,
      init_images: [await base64(request.image)],
      ...(request.mask ? { mask: await base64(request.mask), inpainting_fill: 1 } : {}),
      width: size(request.width),
      height: size(request.height),
      denoising_strength: request.strength,
    };
    const response = await this.post("/sdapi/v1/img2img", body, signal);
    const image = ((await response.json()) as { images?: string[] }).images?.[0];
    if (!image) throw new PixError(ErrorCode.LocalEngineFailed, "The engine returned no picture", { address: this.address });
    return new Blob([Base64.decode(image) as Uint8Array<ArrayBuffer>], { type: "image/png" });
  }

  async models(signal: AbortSignal): Promise<EngineModels> {
    // Paragraph: read the folder again, so a model the user just added appears.
    await this.post("/sdapi/v1/refresh-checkpoints", {}, signal);
    const [list, options] = await Promise.all([
      this.getJson<{ title: string }[]>("/sdapi/v1/sd-models", signal),
      this.getJson<{ sd_model_checkpoint?: string }>("/sdapi/v1/options", signal),
    ]);
    return { current: options.sd_model_checkpoint ?? null, list: list.map((m) => ({ id: m.title, needsBrush: false, hasStrength: true })) };
  }

  async useModel(id: string, signal: AbortSignal): Promise<void> {
    await this.post("/sdapi/v1/options", { sd_model_checkpoint: id }, signal);
  }
}

export type EngineDevice = "cpu" | "cuda";

/**
 * Commands for the user to run: a browser extension cannot start a program, and these servers have no
 * call to download or delete a model, or to change device.
 */
export class EngineCommands {
  private static readonly SAFE_MODEL = /^[\w./:-]+$/;

  /** A model name that is safe to put in a command, or an error saying why not. */
  static model(name: string): string {
    const clean = name.trim();
    if (!EngineCommands.SAFE_MODEL.test(clean)) throw new PixError(ErrorCode.InvalidService, "A model name has only letters, digits and . / : _ -", { length: clean.length });
    return clean;
  }

  static start(kind: EngineKind, device: EngineDevice, model: string, address: string): string {
    const port = new URL(address).port;
    if (kind === "iopaint") return `iopaint start --model=${EngineCommands.model(model)} --device=${device}${port ? ` --port=${port}` : ""}`;
    return `webui --api${port ? ` --port ${port}` : ""}${device === "cpu" ? " --use-cpu all --skip-torch-cuda-test --no-half" : ""}`;
  }

  /** Null when the runtime has no such command: its models are files in a folder. */
  static download(kind: EngineKind, model: string): string | null {
    return kind === "iopaint" ? `iopaint download --model=${EngineCommands.model(model)}` : null;
  }
}

export class LocalAddress {
  /** A clean base address, or an error saying why not. */
  static parse(text: string): string {
    let url: URL;
    try {
      url = new URL(text.trim());
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.InvalidService, "Not a web address", { text: text.slice(0, 80) });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new PixError(ErrorCode.InvalidService, "The address must start with http:// or https://", { protocol: url.protocol });
    return url.origin;
  }

  /** Asks to reach this address. Must start from a click. */
  static request(address: string): Promise<boolean> {
    return chrome.permissions.request({ origins: [`${address}/*`] });
  }
}

export type DesktopOs = "windows" | "mac" | "linux";

/**
 * Pixlixir AI: IOPaint with LaMa, installed by one command into one folder with its own Python, and
 * removed by another (scripts/install/ai-*.ps1 and ai-*.sh, ADR-0011). A browser cannot run them, so
 * Settings shows them to copy.
 */
export class PixlixirAi {
  static readonly NAME = "Pixlixir AI";
  static readonly ADDRESS = "http://127.0.0.1:8080";
  private static readonly BASE = "https://raw.githubusercontent.com/GreenFuze/Pixlixir/main/scripts/install";

  static commands(os: DesktopOs): { install: string; uninstall: string } {
    if (os === "windows") return { install: `irm ${PixlixirAi.BASE}/ai-install.ps1 | iex`, uninstall: `irm ${PixlixirAi.BASE}/ai-uninstall.ps1 | iex` };
    return { install: `curl -fsSL ${PixlixirAi.BASE}/ai-install.sh | bash`, uninstall: `curl -fsSL ${PixlixirAi.BASE}/ai-uninstall.sh | bash` };
  }

  /** The system this browser runs on, from what it reports. */
  static osOf(platform: string): DesktopOs {
    const p = platform.toLowerCase();
    if (p.includes("win")) return "windows";
    if (p.includes("mac")) return "mac";
    return "linux";
  }

  /** Whether the engine answers at its address. Needs permission to reach it. */
  static async running(signal: AbortSignal): Promise<boolean> {
    try {
      return (await fetch(`${PixlixirAi.ADDRESS}/api/v1/server-config`, { signal })).ok;
    } catch (err) {
      // Paragraph: a refused connection means it is not running; a stop is passed on.
      if (signal.aborted) throw err;
      return false;
    }
  }
}
