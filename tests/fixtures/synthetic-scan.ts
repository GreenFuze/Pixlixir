/**
 * Synthetic scan builder: draws rotated "prints" with textured content on a
 * background. No personal photos are ever used as fixtures.
 */

import type { Point } from "../../src/imaging/geometry.js";
import { Raster, type RgbaImage } from "../../src/imaging/raster.js";

export interface PrintSpec {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angleDeg: number;
  /** Paper border colour and width (px); 0 = no border. */
  border?: { rgb: [number, number, number]; width: number };
  /** Draw a 1px darker outline (paper edge shadow). */
  edgeShadow?: boolean;
  seed: number;
}

export class SyntheticScan {
  readonly image: RgbaImage;

  constructor(width: number, height: number, background: [number, number, number], noise = 4) {
    this.image = Raster.createRgba(width, height);
    const rand = SyntheticScan.rng(12345);
    for (let i = 0; i < width * height; i++) {
      const n = (rand() - 0.5) * 2 * noise;
      this.image.data[i * 4] = background[0] + n;
      this.image.data[i * 4 + 1] = background[1] + n;
      this.image.data[i * 4 + 2] = background[2] + n;
      this.image.data[i * 4 + 3] = 255;
    }
  }

  addPrint(spec: PrintSpec): Point[] {
    const rand = SyntheticScan.rng(spec.seed);
    const a = (spec.angleDeg * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    const base = [rand() * 200, rand() * 200, rand() * 200];
    const { width: W, height: H, data } = this.image;
    const bw = spec.border?.width ?? 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Paragraph: inverse-rotate into print-local coordinates.
        const dx = x + 0.5 - spec.cx, dy = y + 0.5 - spec.cy;
        const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
        if (Math.abs(lx) > spec.w / 2 || Math.abs(ly) > spec.h / 2) continue;

        // Paragraph: paint edge, border or textured content.
        const i = (y * W + x) * 4;
        const distEdge = Math.min(spec.w / 2 - Math.abs(lx), spec.h / 2 - Math.abs(ly));
        let rgb: [number, number, number];
        if (spec.edgeShadow && distEdge < 1.5) rgb = [150, 150, 150];
        else if (distEdge < bw) rgb = spec.border!.rgb;
        else {
          const t = Math.sin(lx / 9) * 40 + Math.cos(ly / 13) * 40 + (rand() - 0.5) * 30;
          rgb = [base[0]! + t, base[1]! + t * 0.6, base[2]! - t * 0.4];
        }
        data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
      }
    }
    // Ground-truth corners (TL, TR, BR, BL before rotation).
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const lx = (sx! * spec.w) / 2, ly = (sy! * spec.h) / 2;
      return { x: spec.cx + lx * cos - ly * sin, y: spec.cy + lx * sin + ly * cos };
    });
  }

  /** A print photographed at an angle: arbitrary convex quad (TL, TR, BR, BL). */
  addQuadPrint(corners: Point[], seed: number): Point[] {
    const rand = SyntheticScan.rng(seed);
    const base = [rand() * 200, rand() * 200, rand() * 200];
    const { width: W, height: H, data } = this.image;
    const inside = (x: number, y: number) =>
      corners.every((a, i) => {
        const b = corners[(i + 1) % corners.length]!;
        return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) >= 0;
      });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!inside(x + 0.5, y + 0.5)) continue;
        const t = Math.sin(x / 9) * 40 + Math.cos(y / 13) * 40 + (rand() - 0.5) * 30;
        const i = (y * W + x) * 4;
        data[i] = base[0]! + t; data[i + 1] = base[1]! + t * 0.6; data[i + 2] = base[2]! - t * 0.4; data[i + 3] = 255;
      }
    }
    return corners;
  }

  /** Multiplies every pixel by an illumination factor (soft shadow / uneven light). */
  shade(factor: (x: number, y: number) => number): void {
    const { width: W, height: H, data } = this.image;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const f = factor(x, y), i = (y * W + x) * 4;
      data[i] = data[i]! * f; data[i + 1] = data[i + 1]! * f; data[i + 2] = data[i + 2]! * f;
    }
  }

  /** Adds a soft, desaturating specular highlight (glossy-print glare). */
  addGlare(cx: number, cy: number, radius: number, strength = 0.9): void {
    const { width: W, height: H, data } = this.image;
    for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(H, cy + radius); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(W, cx + radius); x++) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        if (d >= 1) continue;
        const a = strength * Math.min(1, 1.6 * (1 - d * d));
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) data[i + c] = data[i + c]! * (1 - a) + 250 * a;
      }
    }
  }

  static rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }
}
