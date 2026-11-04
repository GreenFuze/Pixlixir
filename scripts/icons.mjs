// Generates the Pixlixir PNG icons procedurally (no binary assets in the repo).
import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

export class IconFactory {
  async writeAll(dir, sizes) {
    for (const s of sizes) await writeFile(`${dir}/${s}.png`, this.png(s));
  }

  /** Rounded square with a purple-magenta gradient and a white four-point sparkle. */
  png(size) {
    const px = Buffer.alloc(size * size * 4);
    const r = size * 0.22;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        // rounded-rect coverage
        const dx = Math.max(r - cx, cx - (size - r), 0), dy = Math.max(r - cy, cy - (size - r), 0);
        const inside = Math.hypot(dx, dy) <= r;
        if (!inside) continue;
        const t = (cx + cy) / (2 * size);
        let R = 123 + (210 - 123) * t, G = 77, B = 255 + (255 - 255) * t;
        // sparkle: |u|^0.5 + |v|^0.5 <= k
        const u = Math.abs(cx - size / 2) / (size * 0.36), v = Math.abs(cy - size / 2) / (size * 0.36);
        if (Math.sqrt(u) + Math.sqrt(v) <= 1) { R = 255; G = 255; B = 255; }
        const i = (y * size + x) * 4;
        px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;
      }
    }
    return this.encode(size, size, px);
  }

  encode(w, h, rgba) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 4 + 1)] = 0;
      rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), this.chunk("IHDR", ihdr), this.chunk("IDAT", deflateSync(raw)), this.chunk("IEND", Buffer.alloc(0))]);
  }

  chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(IconFactory.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  }

  static crc32(buf) {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c;
  }
}
