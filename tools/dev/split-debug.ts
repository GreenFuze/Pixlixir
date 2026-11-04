/**
 * Developer harness: runs scan splitting on a local image and writes debug
 * images to captures/debug/. Usage:
 *   npm run dev:split -- captures/sample.jpg
 * Input images must stay in captures/ (gitignored) — never commit personal photos.
 */
import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { Raster, type RgbaImage } from "../../src/imaging/raster.js";
import { PrintDetector } from "../../src/imaging/split/detector.js";
import { PerspectiveWarper } from "../../src/imaging/warp.js";
import { AdjustmentPresets } from "../../src/imaging/enhance/adjustments.js";
import { EnhancePipeline } from "../../src/imaging/enhance/pipeline.js";
import { IlluminationField } from "../../src/imaging/enhance/illumination.js";
import { ImageIO } from "./image-io.js";

const input = process.argv[2];
if (!input) throw new Error("usage: split-debug <image.jpg>");
const out = `captures/debug/${basename(input).replace(/\.\w+$/, "")}`;
mkdirSync(out, { recursive: true });

const src = ImageIO.readJpeg(input);
const t0 = performance.now();
const prints = new PrintDetector().detect(src, (stage, img) => (img.width > 1 ? ImageIO.writeMask(`${out}/stage-${stage}.jpg`, img) : console.log(`stage: ${stage}`)));
console.log(`detect: ${(performance.now() - t0).toFixed(0)} ms, ${prints.length} prints, source ${src.width}x${src.height}`);

const field = IlluminationField.estimate(src);
console.log(`illumination field: ${field ? 'ok' : 'unavailable'}`);

// Paragraph: overlay quads on a downscaled copy.
const { image: small, scale } = Raster.downscale(src, 900);
const overlay: RgbaImage = { width: small.width, height: small.height, data: new Uint8ClampedArray(small.data) };
const colors = [[255, 0, 255], [0, 255, 0], [0, 160, 255], [255, 128, 0], [255, 255, 0]];
prints.forEach((p, n) => {
  const c = colors[n % colors.length]!;
  for (let k = 0; k < 4; k++) {
    const a = p.quad[k]!, b = p.quad[(k + 1) % 4]!;
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * scale);
    for (let s = 0; s <= steps; s++) {
      const x = Math.round((a.x + ((b.x - a.x) * s) / steps) * scale), y = Math.round((a.y + ((b.y - a.y) * s) / steps) * scale);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= overlay.width || yy >= overlay.height) continue;
        const i = (yy * overlay.width + xx) * 4; overlay.data[i] = c[0]!; overlay.data[i + 1] = c[1]!; overlay.data[i + 2] = c[2]!;
      }
    }
  }
  console.log(`  #${n + 1} conf=${p.confidence.toFixed(2)} area=${(p.areaFraction * 100).toFixed(1)}% quad=${p.quad.map((q) => `${q.x.toFixed(0)},${q.y.toFixed(0)}`).join(" ")}`);
  const t1 = performance.now();
  const rect = PerspectiveWarper.rectify(src, p.quad);
  ImageIO.writeJpeg(`${out}/print-${n + 1}.jpg`, rect);
  console.log(`     rectified ${rect.width}x${rect.height} in ${(performance.now() - t1).toFixed(0)} ms`);
  const t2 = performance.now();
  const fixed = EnhancePipeline.apply(rect, AdjustmentPresets.auto(), { lightingGain: field ? field.gainPlane(p.quad, rect.width, rect.height, 0.5) : null, wantMask: true });
  console.log(`     enhanced in ${(performance.now() - t2).toFixed(0)} ms, glare ${(fixed.report.glareCoverage * 100).toFixed(1)}%, lighting ${fixed.report.lightingApplied}`);
  ImageIO.writeJpeg(`${out}/print-${n + 1}-fixed.jpg`, fixed.image);
  // Side-by-side: original | fixed | treated-mask overlay (magenta)
  const sbs = Raster.createRgba(rect.width * 3, rect.height);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) {
    const i = (y * rect.width + x) * 4, m = fixed.treatedMask ? fixed.treatedMask[y * rect.width + x]! : 0;
    for (let c = 0; c < 4; c++) {
      sbs.data[(y * rect.width * 3 + x) * 4 + c] = rect.data[i + c]!;
      sbs.data[(y * rect.width * 3 + rect.width + x) * 4 + c] = fixed.image.data[i + c]!;
    }
    const k = (y * rect.width * 3 + 2 * rect.width + x) * 4;
    sbs.data[k] = rect.data[i]! * (1 - m) + 255 * m; sbs.data[k + 1] = rect.data[i + 1]! * (1 - m); sbs.data[k + 2] = rect.data[i + 2]! * (1 - m) + 255 * m; sbs.data[k + 3] = 255;
  }
  ImageIO.writeJpeg(`${out}/print-${n + 1}-compare.jpg`, Raster.downscale(sbs, 2400).image);
});
ImageIO.writeJpeg(`${out}/overlay.jpg`, overlay);
console.log(`wrote ${out}/`);
