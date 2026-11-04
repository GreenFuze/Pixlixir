/**
 * Applies a photo's Adjustments in a fixed, physically sensible order:
 * glare (auto + brush) → dust → repair brush → lighting → colour → sharpen.
 */

import { Raster, type RgbaImage } from "../raster.js";
import type { Adjustments } from "./adjustments.js";
import { GlareRemover } from "./glare.js";
import { DefectRepairer, StrokeRasterizer } from "./repair.js";
import { LightingCorrector } from "./illumination.js";
import { ColorRestorer, Sharpener } from "./tone.js";

export interface EnhanceReport {
  glareCoverage: number;
  dustPixels: number;
  /** False when lighting was requested but no scene lighting measurement was available. */
  lightingApplied: boolean;
}

export interface EnhanceContext {
  /** Lighting gain plane for this print (from IlluminationField), or null if unavailable. */
  lightingGain: Float32Array | null;
  wantMask: boolean;
}

export interface EnhanceResult {
  image: RgbaImage;
  report: EnhanceReport;
  /** Optional overlay of what was treated automatically (glare + dust), 0..1. */
  treatedMask: Float32Array | null;
}

export class EnhancePipeline {
  static apply(src: RgbaImage, adj: Adjustments, ctx: EnhanceContext): EnhanceResult {
    Raster.assertRgba(src);
    const { width: w, height: h } = src;
    const { glare, repair, protect } = StrokeRasterizer.masks(adj.strokes, w, h);
    const treated = ctx.wantMask ? new Float32Array(w * h) : null;
    const report: EnhanceReport = { glareCoverage: 0, dustPixels: 0, lightingApplied: false };
    let img = src;

    // Paragraph: defects first, so later global statistics are not skewed by them.
    if (adj.glare.enabled || glare) {
      const g = GlareRemover.apply(img, adj.glare.enabled ? adj.glare.sensitivity : null, glare, protect);
      img = g.image;
      report.glareCoverage = g.coverage;
      if (treated) for (let i = 0; i < treated.length; i++) treated[i] = Math.max(treated[i]!, g.mask[i]!);
    }
    if (adj.dust.enabled) {
      const dust = DefectRepairer.detectDust(img, adj.dust.sensitivity, protect);
      for (const v of dust) if (v > 0.5) report.dustPixels++;
      if (report.dustPixels > 0) img = DefectRepairer.fillMasked(img, dust);
      if (treated) for (let i = 0; i < treated.length; i++) treated[i] = Math.max(treated[i]!, dust[i]!);
    }
    if (repair) img = DefectRepairer.fillMasked(img, repair);

    // Paragraph: global tone and colour.
    if (adj.lighting.enabled && ctx.lightingGain) {
      img = LightingCorrector.apply(img, ctx.lightingGain);
      report.lightingApplied = true;
    }
    if (adj.color.enabled) img = ColorRestorer.apply(img, adj.color.mode, adj.color.strength);
    if (adj.sharpen.enabled) img = Sharpener.apply(img, adj.sharpen.amount);

    return { image: img, report, treatedMask: treated };
  }
}
