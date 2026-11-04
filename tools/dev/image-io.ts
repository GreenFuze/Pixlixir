/** Node-only image I/O for developer tooling (never bundled into the extension). */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import jpeg from "jpeg-js";
import type { GrayImage, RgbaImage } from "../../src/imaging/raster.js";

export class ImageIO {
  static readJpeg(path: string): RgbaImage {
    const d = jpeg.decode(readFileSync(path), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.length) };
  }

  static writeJpeg(path: string, img: RgbaImage, quality = 90): void {
    writeFileSync(path, jpeg.encode({ width: img.width, height: img.height, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) }, quality).data);
  }

  static writeMask(path: string, mask: GrayImage): void {
    const rgba = new Uint8ClampedArray(mask.width * mask.height * 4);
    for (let i = 0; i < mask.data.length; i++) { const v = mask.data[i]! > 1 ? mask.data[i]! : mask.data[i]! * 255; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
    ImageIO.writeJpeg(path, { width: mask.width, height: mask.height, data: rgba });
  }

  static writePng(path: string, img: RgbaImage): void {
    const { width: w, height: h } = img;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) Buffer.from(img.data.buffer, img.data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
      let c = ~0; for (const b of td) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
      const crc = Buffer.alloc(4); crc.writeUInt32BE(~c >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
  }
}
