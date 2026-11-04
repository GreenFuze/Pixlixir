/**
 * Glare (specular reflection) reduction for photographed glossy prints.
 *
 * Model: observed = (1 − a)·true + a·white, where `a` is the local glare
 * amount. Glare areas come from (1) conservative automatic detection of
 * near-clipped, colourless, soft-edged hotspots and (2) areas the user painted
 * with the Glare brush. We estimate the underlying photo by inpainting from
 * the unaffected surroundings, derive `a` per pixel, and invert the model
 * (recovering real detail). Fully clipped pixels inside automatically detected
 * hotspots are replaced by the inpainted estimate (detail there is gone).
 *
 * Automatic detection deliberately ignores broad, faint sheen: on a single
 * photo it is indistinguishable from pale content (white walls, shirts), so
 * that case is left to the brush rather than risk damaging the picture.
 */

import { Raster, type RgbaImage } from "../raster.js";
import { BinaryMorphology } from "../split/binary.js";
import { Plane } from "./filters.js";
import { PullPushInpainter } from "./inpaint.js";

export interface GlareResult {
  image: RgbaImage;
  /** Glare amount 0..1 per pixel (for UI overlays). */
  mask: Float32Array;
  /** Fraction of the photo treated. */
  coverage: number;
}

export class GlareRemover {
  static readonly ANALYSIS_SIDE = 800;

  /**
   * @param auto     run automatic hotspot detection with this sensitivity (null = off)
   * @param painted  Glare-brush mask (0..1) or null
   * @param protect  Protect-brush mask (0..1) or null
   */
  static apply(img: RgbaImage, auto: number | null, painted: Float32Array | null, protect: Float32Array | null): GlareResult {
    const { width: w, height: h } = img;

    // Paragraph: automatic detection on a downscaled copy (stable across preview/full resolution), plus brush.
    const autoMask = new Float32Array(w * h);
    if (auto !== null) {
      const { image: small } = Raster.downscale(img, GlareRemover.ANALYSIS_SIDE);
      const smallMask = GlareRemover.detect(small, auto);
      if (smallMask.some((v) => v > 0)) autoMask.set(Plane.upsample(smallMask, small.width, small.height, w, h));
    }
    const mask = Float32Array.from(autoMask);
    if (painted) for (let i = 0; i < mask.length; i++) mask[i] = Math.max(mask[i]!, painted[i]!);
    if (protect) for (let i = 0; i < mask.length; i++) { mask[i] = mask[i]! * (1 - protect[i]!); autoMask[i] = autoMask[i]! * (1 - protect[i]!); }
    let covered = 0;
    for (const v of mask) if (v > 0.2) covered++;
    if (covered === 0) return { image: img, mask, coverage: 0 };

    // Paragraph: estimate the photo under the glare from unaffected surroundings.
    const known = new Float32Array(w * h);
    for (let i = 0; i < known.length; i++) known[i] = 1 - Plane.smoothstep(mask[i]!, 0.02, 0.25);
    const fill = PullPushInpainter.fill(img, known);

    // Paragraph: estimate the smooth glare veil and invert the model; fall back to the fill where glare is opaque.
    const veil = GlareRemover.veil(img, fill, mask);
    const out = Raster.createRgba(w, h);
    const s = img.data, f = fill.data, o = out.data;
    for (let i = 0; i < w * h; i++) {
      const k = i * 4, m = mask[i]!;
      if (m <= 0.001) {
        o[k] = s[k]!; o[k + 1] = s[k + 1]!; o[k + 2] = s[k + 2]!; o[k + 3] = s[k + 3]!;
        continue;
      }
      // Invert the veil (amplification capped at 5x). Clipped pixels carry no information: inside
      // automatically detected hotspots they are filled from the surroundings; under the Glare brush
      // they are left as they are (painting blown-out areas to fill them is the Repair brush's job).
      const a = Math.min(0.8, veil[i]!);
      const clipped = Plane.smoothstep(Math.min(s[k]!, s[k + 1]!, s[k + 2]!), 244, 254);
      const opaque = clipped * Math.min(1, autoMask[i]! / Math.max(1e-3, m));
      for (let c = 0; c < 3; c++) {
        const recovered = (s[k + c]! - a * GlareRemover.GLARE_LEVEL) / (1 - a);
        const fixedValue = recovered * (1 - opaque) + f[k + c]! * opaque;
        o[k + c] = s[k + c]! * (1 - m) + fixedValue * m;
      }
      o[k + 3] = s[k + 3]!;
    }
    return { image: out, mask, coverage: covered / (w * h) };
  }

  /** Brightness of the reflected light (near white). */
  static readonly GLARE_LEVEL = 250;

  /**
   * Smooth glare-veil amount per pixel. Per pixel, the veil is bounded by the
   * channel that rose least above the inpainted estimate (glare lifts all
   * channels toward white). A morphological opening then removes thin bright
   * structures that are real content (light beams, highlights), and a blur
   * keeps the veil smooth — reflections vary slowly across the print.
   */
  static veil(img: RgbaImage, fill: RgbaImage, mask: Float32Array): Float32Array {
    const { width: w, height: h } = img;
    const raw = new Float32Array(w * h);
    for (let i = 0, k = 0; i < raw.length; i++, k += 4) {
      if (mask[i]! <= 0.001) continue;
      let a = 1;
      // Denominator kept >= 8: where the estimate is already near white, glare cannot be measured (a -> 0).
      for (let c = 0; c < 3; c++) a = Math.min(a, (img.data[k + c]! - fill.data[k + c]!) / Math.max(8, GlareRemover.GLARE_LEVEL - fill.data[k + c]!));
      raw[i] = Math.max(0, Math.min(0.92, a)) * mask[i]!;
    }

    // Paragraph: open + blur on a reduced grid (fast at any resolution), then upsample.
    const side = Math.min(600, Math.max(w, h));
    const sw = Math.max(1, Math.round((w * side) / Math.max(w, h))), sh = Math.max(1, Math.round((h * side) / Math.max(w, h)));
    const small = Plane.downsample(raw, w, h, sw, sh);
    const r = Math.max(2, Math.round(side * 0.012));
    // Blur first: glare on glossy paper is speckled ("orange peel"); averaging keeps it while
    // the opening still removes thin real highlights such as light beams.
    const averaged = Plane.boxBlur(small, sw, sh, r);
    const opened = Plane.rankFilter(Plane.rankFilter(averaged, sw, sh, r, "min"), sw, sh, r, "max");
    const smooth = Plane.boxBlur(opened, sw, sh, r);
    const veil = Plane.upsample(smooth, sw, sh, w, h);
    for (let i = 0; i < veil.length; i++) veil[i] = Math.min(veil[i]!, raw[i]! + 0.05);
    return veil;
  }

  /** Soft glare mask (0..1) for a small image. */
  static detect(img: RgbaImage, sensitivity: number): Float32Array {
    const { width: w, height: h, data } = img;
    const n = w * h;

    // Paragraph: per-pixel cues: brightness, low saturation, brighter than the local surroundings.
    const v = new Float32Array(n), sat = new Float32Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const mx = Math.max(data[i]!, data[i + 1]!, data[i + 2]!), mn = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
      v[p] = mx;
      sat[p] = mx > 0 ? (mx - mn) / mx : 0;
    }
    const local = Plane.boxBlur(v, w, h, Math.max(4, Math.round(Math.max(w, h) * 0.06)));
    const vLo = 240 - 22 * sensitivity, dLo = 30 - 15 * sensitivity;
    const score = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      score[p] = Plane.smoothstep(v[p]!, vLo, Math.min(254, vLo + 12)) * (1 - Plane.smoothstep(sat[p]!, 0.06, 0.16)) * Plane.smoothstep(v[p]! - local[p]!, dLo, dLo + 30);
    }

    // Paragraph: keep blobs that are big enough (not catch-lights) and soft-edged (not white objects).
    const bin = Raster.createGray(w, h);
    for (let p = 0; p < n; p++) bin.data[p] = score[p]! > 0.3 ? 1 : 0;
    const { components, labels } = BinaryMorphology.components(bin);
    const minArea = Math.max(12, n * 0.0006);
    const keep = new Set<number>();
    for (const c of components) {
      if (c.area < minArea) continue;
      if (GlareRemover.boundarySharpness(v, labels, c.label, w, h) > GlareRemover.MAX_EDGE_DROP) continue;
      keep.add(c.label);
    }

    // Paragraph: soft mask restricted to kept blobs, slightly feathered outward.
    const raw = new Float32Array(n);
    for (let p = 0; p < n; p++) raw[p] = keep.has(labels[p]!) ? Math.max(score[p]!, 0.5) : 0;
    const feathered = Plane.boxBlur(raw, w, h, 2);
    for (let p = 0; p < n; p++) feathered[p] = Math.min(1, Math.max(raw[p]!, feathered[p]! * 1.5));
    return feathered;
  }

  /** Mean brightness drop (levels) across a blob's edge above which it is an object, not glare. */
  static readonly MAX_EDGE_DROP = 22;

  /**
   * How abrupt the blob's boundary is: mean brightness drop (in levels) from
   * just inside to two pixels outside its edge. Glare fades out gradually
   * (low), a white object ends abruptly (high).
   */
  static boundarySharpness(v: Float32Array, labels: Int32Array, label: number, w: number, h: number): number {
    let jump = 0, count = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (labels[i] !== label) continue;
        for (const j of [i - 1, i + 1, i - w, i + w]) {
          if (labels[j] === label) continue;
          // Compare the pixel 1 step inside with 2 steps outside.
          const outside = j + (j - i);
          if (outside < 0 || outside >= w * h) continue;
          jump += Math.max(0, v[i]! - v[outside]!);
          count++;
        }
      }
    }
    if (count === 0) return 0;
    return jump / count;
  }
}
