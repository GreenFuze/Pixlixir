/**
 * Maps normalised coordinates between the displayed (rotated) photo and the
 * rectified photo before rotation, where brush strokes are stored.
 * Rotation is in clockwise quarter turns, matching Raster.rotate90.
 */
export class QuarterTurn {
  /** Displayed (x, y) in [0,1] → unrotated (u, v) in [0,1]. */
  static toUnrotated(x: number, y: number, quarterTurns: number): { u: number; v: number } {
    switch (((quarterTurns % 4) + 4) % 4) {
      case 1:
        return { u: y, v: 1 - x };
      case 2:
        return { u: 1 - x, v: 1 - y };
      case 3:
        return { u: 1 - y, v: x };
      default:
        return { u: x, v: y };
    }
  }

  /** Unrotated (u, v) → displayed (x, y); inverse of toUnrotated. */
  static toDisplayed(u: number, v: number, quarterTurns: number): { x: number; y: number } {
    switch (((quarterTurns % 4) + 4) % 4) {
      case 1:
        return { x: 1 - v, y: u };
      case 2:
        return { x: 1 - u, y: 1 - v };
      case 3:
        return { x: v, y: 1 - u };
      default:
        return { x: u, y: v };
    }
  }
}
