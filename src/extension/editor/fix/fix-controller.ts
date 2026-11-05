/**
 * Contract between the Fix feature (per-photo fixes UI) and any tool that hosts it.
 *
 * Fix is its own feature: Split hosts it for every print today, and a standalone
 * "Fix a photo" tool will host it for single library photos later. Hosts own the
 * photo state and the rendering; the Fix panel only reads a FixTarget + FixView
 * and calls these intent methods.
 */

import type { Adjustments, BrushStroke } from "../../../imaging/enhance/adjustments.js";
import type { EnhanceReport } from "../../../imaging/enhance/pipeline.js";

/** The photo being fixed, as the Fix panel needs to see it. */
export interface FixTarget {
  id: string;
  /** Quarter turns clockwise applied to the displayed photo (brush strokes are stored unrotated). */
  rotation: number;
  adjustments: Adjustments;
}

/** Large previews rendered by the host for the open Fix panel. */
export interface FixView {
  targetId: string;
  fixedUrl: string | null;
  originalUrl: string | null;
  maskUrl: string | null;
  report: EnhanceReport | null;
  busy: boolean;
}

export interface FixController {
  setAdjustments(id: string, adjustments: Adjustments): void;
  addStroke(id: string, stroke: BrushStroke): void;
  undoStroke(id: string): void;
  rotate(id: string, delta: 1 | -1): void;
  closeFix(): void;
  /** Only hosts with several photos (e.g. Split) offer "use these settings for all photos". */
  applySettingsToAll?(fromId: string): void;
}
