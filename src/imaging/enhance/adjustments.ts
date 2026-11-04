/**
 * Per-photo fix settings. Plain data so they can be persisted with the job
 * and sent to the worker. Brush strokes use coordinates normalised to the
 * rectified photo (before rotation), so they apply at any resolution.
 */

export type ColorMode = "restore" | "preserve";

export interface BrushStroke {
  /**
   * "glare" = remove a glare veil here (keeps detail where possible);
   * "repair" = fill this area from its surroundings (dust, scratches, creases, tears);
   * "protect" = exclude from automatic fixes.
   */
  kind: "glare" | "repair" | "protect";
  /** Brush radius as a fraction of the photo's longer side. */
  radius: number;
  /** Polyline in normalised [0,1] coordinates of the rectified photo. */
  points: { u: number; v: number }[];
}

export interface Adjustments {
  glare: { enabled: boolean; sensitivity: number };
  lighting: { enabled: boolean; strength: number };
  color: { enabled: boolean; mode: ColorMode; strength: number };
  dust: { enabled: boolean; sensitivity: number };
  sharpen: { enabled: boolean; amount: number };
  strokes: BrushStroke[];
}

export class AdjustmentPresets {
  /** Auto-fix defaults applied to newly detected photos (shown to the user, with before/after). */
  static auto(): Adjustments {
    return {
      glare: { enabled: true, sensitivity: 0.5 },
      lighting: { enabled: true, strength: 0.5 },
      color: { enabled: true, mode: "restore", strength: 0.6 },
      dust: { enabled: false, sensitivity: 0.5 },
      sharpen: { enabled: true, amount: 0.3 },
      strokes: [],
    };
  }

  /** No changes at all (the "original" rendition). */
  static none(): Adjustments {
    return {
      glare: { enabled: false, sensitivity: 0.5 },
      lighting: { enabled: false, strength: 0.5 },
      color: { enabled: false, mode: "restore", strength: 0.6 },
      dust: { enabled: false, sensitivity: 0.5 },
      sharpen: { enabled: false, amount: 0.3 },
      strokes: [],
    };
  }

  static isIdentity(a: Adjustments): boolean {
    return !a.glare.enabled && !a.lighting.enabled && !a.color.enabled && !a.dust.enabled && !a.sharpen.enabled && a.strokes.length === 0;
  }
}
