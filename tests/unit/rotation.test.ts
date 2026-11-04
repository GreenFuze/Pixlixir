import { describe, expect, it } from "vitest";
import { QuarterTurn } from "../../src/extension/editor/rotation.js";
import { Raster } from "../../src/imaging/raster.js";

describe("QuarterTurn", () => {
  it("agrees with Raster.rotate90 for every rotation", () => {
    // 4x2 image with a single marked pixel at unrotated (3, 0) -> centre (u, v) = (3.5/4, 0.5/2).
    const img = Raster.createRgba(4, 2);
    img.data.set([255, 0, 0, 255], (0 * 4 + 3) * 4);
    for (let t = 0; t < 4; t++) {
      const r = Raster.rotate90(img, t);
      let px = -1, py = -1;
      for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) if (r.data[(y * r.width + x) * 4] === 255) { px = x; py = y; }
      const d = QuarterTurn.toDisplayed(3.5 / 4, 0.5 / 2, t);
      expect([Math.floor(d.x * r.width), Math.floor(d.y * r.height)]).toEqual([px, py]);
      const back = QuarterTurn.toUnrotated(d.x, d.y, t);
      expect(back.u).toBeCloseTo(3.5 / 4);
      expect(back.v).toBeCloseTo(0.25);
    }
  });
});
