/** Synthetic pictures for comparing photos: one scene, seen whole, cropped or with a part changed. */

import { LumaImage, WHOLE, type Region } from "../../src/scan/fine-check.js";

/** A scene with detail everywhere, so a crop has one place where it fits. */
const scene = (x: number, y: number) => 128 + 50 * Math.sin(13 * x + 2 * y) + 40 * Math.cos(9 * y - 4 * x) + 30 * Math.sin(37 * x * y + 5 * y);
/** The part of the scene in `r` (scene units), seen at width x height. */
export function view(width: number, height: number, r: Region = WHOLE, edit?: (x: number, y: number, v: number) => number): LumaImage {
  const out = new Uint8Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = r.x + ((i + 0.5) / width) * r.w, y = r.y + ((j + 0.5) / height) * r.h;
      const v = scene(x, y);
      out[j * width + i] = Math.max(0, Math.min(255, Math.round(edit ? edit(x, y, v) : v)));
    }
  }
  return new LumaImage(width, height, out);
}
/** Someone moved: one patch of the scene is different. */
export const moved = (x: number, y: number, v: number) => (x > 0.4 && x < 0.45 && y > 0.3 && y < 0.36 ? (v + 128) % 256 : v);
