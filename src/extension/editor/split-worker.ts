/**
 * Web worker for scan splitting: decodes once, detects prints, measures the
 * scene lighting, and renders rectified + fixed outputs (full-resolution
 * JPEGs, previews, and "treated area" overlays) off the UI thread.
 */

import type { Quad } from "../../imaging/geometry.js";
import type { Adjustments } from "../../imaging/enhance/adjustments.js";
import { IlluminationField } from "../../imaging/enhance/illumination.js";
import { EnhancePipeline, type EnhanceReport } from "../../imaging/enhance/pipeline.js";
import { Raster, type RgbaImage } from "../../imaging/raster.js";
import { PrintDetector, type DetectedPrint } from "../../imaging/split/detector.js";
import { PerspectiveWarper } from "../../imaging/warp.js";
import { ErrorCode, PixError } from "../../shared/errors.js";
import { CanvasCodec } from "./canvas-codec.js";
import { WorkerRpcServer } from "./worker-rpc.js";

export interface RenderRequest {
  quad: Quad;
  rotation: number;
  adjustments: Adjustments;
  /** "thumb" ≈ 400 px, "preview" ≈ 1400 px, "full" = source resolution. */
  size: "thumb" | "preview" | "full";
  wantMask: boolean;
}

export interface RenderResult {
  image: Blob;
  /** Semi-transparent PNG marking automatically treated areas, if requested. */
  mask: Blob | null;
  report: EnhanceReport;
}

export type WorkerRequest =
  | { id: number; op: "load"; bitmap: ImageBitmap }
  | { id: number; op: "detect" }
  | ({ id: number; op: "render" } & RenderRequest);

class SplitWorker {
  static readonly SIZES = { thumb: 420, preview: 1400 } as const;
  #full: RgbaImage | null = null;
  #copies = new Map<keyof typeof SplitWorker.SIZES, { image: RgbaImage; scale: number }>();
  #lighting: IlluminationField | null = null;

  handle(req: WorkerRequest): unknown {
    switch (req.op) {
      case "load":
        return this.load(req.bitmap);
      case "detect":
        return this.detect();
      case "render":
        return this.render(req);
    }
  }

  private load(bitmap: ImageBitmap): { width: number; height: number; lightingAvailable: boolean } {
    // Paragraph: decode into RGBA once.
    const full: RgbaImage = CanvasCodec.decode(bitmap);
    this.#full = full;

    // Paragraph: smaller copies of the scan for fast previews (a print covers only part of the scan,
    // hence the 2.2x margin), and the scene lighting measurement.
    this.#copies.clear();
    for (const [name, side] of Object.entries(SplitWorker.SIZES) as [keyof typeof SplitWorker.SIZES, number][]) {
      this.#copies.set(name, Raster.downscale(full, side * 2.2));
    }
    this.#lighting = IlluminationField.estimate(full);
    return { width: full.width, height: full.height, lightingAvailable: this.#lighting !== null };
  }

  private detect(): DetectedPrint[] {
    return new PrintDetector().detect(this.requireFull());
  }

  private async render(req: RenderRequest): Promise<RenderResult> {
    // Paragraph: rectify from the copy matching the requested size.
    const full = this.requireFull();
    const src = req.size === "full" ? { image: full, scale: 1 } : this.#copies.get(req.size)!;
    const scaled = req.quad.map((p) => ({ x: p.x * src.scale, y: p.y * src.scale })) as Quad;
    let rect = PerspectiveWarper.rectify(src.image, scaled);
    if (req.size !== "full") rect = Raster.downscale(rect, SplitWorker.SIZES[req.size]).image;

    // Paragraph: fixes (lighting measured in source coordinates, so it is resolution independent).
    const gain = req.adjustments.lighting.enabled && this.#lighting ? this.#lighting.gainPlane(req.quad, rect.width, rect.height, req.adjustments.lighting.strength) : null;
    const fixed = EnhancePipeline.apply(rect, req.adjustments, { lightingGain: gain, wantMask: req.wantMask });

    // Paragraph: rotate and encode.
    const out = Raster.rotate90(fixed.image, req.rotation);
    const image = await CanvasCodec.encode(out, "image/jpeg", req.size === "full" ? 0.95 : 0.85);
    let mask: Blob | null = null;
    if (fixed.treatedMask) {
      const overlay = Raster.createRgba(rect.width, rect.height);
      for (let i = 0; i < fixed.treatedMask.length; i++) overlay.data.set([255, 0, 200, Math.round(Math.min(1, fixed.treatedMask[i]!) * 170)], i * 4);
      mask = await CanvasCodec.encode(Raster.rotate90(overlay, req.rotation), "image/png", 1);
    }
    return { image, mask, report: fixed.report };
  }

  private requireFull(): RgbaImage {
    if (!this.#full) throw new PixError(ErrorCode.InvalidImage, "No image loaded in the split worker");
    return this.#full;
  }
}

const worker = new SplitWorker();
WorkerRpcServer.serve<WorkerRequest>((req) => worker.handle(req), "Split worker failed");
