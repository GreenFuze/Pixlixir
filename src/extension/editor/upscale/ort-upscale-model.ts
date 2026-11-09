/**
 * Runs the upscaling model with ONNX Runtime Web (MIT), on the GPU through WebGPU or on the CPU.
 * The device is the user's choice, shown on screen; nothing switches device by itself.
 * The runtime's WebAssembly and the model ship inside the extension: nothing is fetched from the web.
 */

import * as ort from "onnxruntime-web/webgpu";
import type { UpscaleModel } from "../../../imaging/upscale/upscaler.js";
import { ErrorCode, PixError } from "../../../shared/errors.js";

export type UpscaleDevice = "gpu" | "cpu";

export class OrtUpscaleModel implements UpscaleModel {
  static readonly MODEL_FILE = "models/realesr-general-x4v3-grain.onnx";
  static readonly RUNTIME_DIR = "ort/";

  private constructor(private readonly session: ort.InferenceSession, readonly device: UpscaleDevice) {}

  /** Whether this browser offers a GPU to WebGPU. */
  static async gpuAvailable(): Promise<boolean> {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return (await gpu.requestAdapter()) !== null;
  }

  /** Loads the model on `device`. `base` is the extension's root URL. */
  static async load(device: UpscaleDevice, base: URL): Promise<OrtUpscaleModel> {
    // Paragraph: the runtime's files come from the extension. One thread: extension pages are not
    // cross-origin isolated, so WebAssembly threads are unavailable.
    ort.env.wasm.wasmPaths = new URL(OrtUpscaleModel.RUNTIME_DIR, base).href;
    ort.env.wasm.numThreads = 1;

    // Paragraph: the model, on the chosen device only.
    try {
      const session = await ort.InferenceSession.create(new URL(OrtUpscaleModel.MODEL_FILE, base).href, { executionProviders: [device === "gpu" ? "webgpu" : "wasm"], graphOptimizationLevel: "all" });
      return new OrtUpscaleModel(session, device);
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.LocalEngineFailed, device === "gpu" ? "The upscaler could not start on the GPU. Try CPU." : "The upscaler could not start.", { device });
    }
  }

  async run(rgb: Float32Array, width: number, height: number, smooth: number): Promise<Float32Array> {
    // Paragraph: `smooth` is the model's strength input: 0 keeps grain and noise, 1 smooths them away.
    const feeds = { image: new ort.Tensor("float32", rgb, [1, 3, height, width]), strength: new ort.Tensor("float32", new Float32Array([smooth]), [1]) };
    let out: ort.InferenceSession.OnnxValueMapType;
    try {
      out = await this.session.run(feeds);
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.LocalEngineFailed, "The upscaler failed on part of the photo.", { device: this.device, width, height });
    }
    const upscaled = out["upscaled"];
    if (!upscaled) throw new PixError(ErrorCode.LocalEngineFailed, "The upscaler returned nothing.", { outputs: Object.keys(out) });
    const data = (await upscaled.getData()) as Float32Array;
    upscaled.dispose();
    return data;
  }

  async release(): Promise<void> {
    await this.session.release();
  }
}
