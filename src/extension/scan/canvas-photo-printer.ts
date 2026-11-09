/** PhotoPrinter on the browser's image decoder: resizes with high quality, since a poor downscale changes the hash. */

import { bmvbhash } from "blockhash-core";
import type { LibraryItem } from "../../domain/types.js";
import type { PhotoPrint, PhotoReader } from "../../scan/duplicates.js";
import { LumaImage } from "../../scan/fine-check.js";
import { ErrorCode, PixError } from "../../shared/errors.js";
import type { PhotosGateway } from "../editor/photos-gateway.js";

export class CanvasPhotoPrinter implements PhotoReader {
  /** Rendition read from Google (about 5 KB). */
  static readonly READ_SIDE = 128;
  private static readonly HASH_SIDE = 64;
  private static readonly HASH_BLOCKS = 16;
  private static readonly TINY_SIDE = 16;

  constructor(private readonly gateway: Pick<PhotosGateway, "thumbnail">) {}

  async print(item: LibraryItem): Promise<PhotoPrint> {
    const blob = await this.gateway.thumbnail(item.baseUrl, CanvasPhotoPrinter.READ_SIDE);
    const forHash = await CanvasPhotoPrinter.pixels(blob, CanvasPhotoPrinter.HASH_SIDE);
    const hash = bmvbhash({ width: CanvasPhotoPrinter.HASH_SIDE, height: CanvasPhotoPrinter.HASH_SIDE, data: forHash }, CanvasPhotoPrinter.HASH_BLOCKS);
    return { hash, tiny: CanvasPhotoPrinter.rgb(await CanvasPhotoPrinter.pixels(blob, CanvasPhotoPrinter.TINY_SIDE)) };
  }

  /** Google's rendition at up to maxSide, at the size Google made it: comparing renditions of one size keeps resizing out of it. */
  async luma(item: LibraryItem, maxSide: number): Promise<LumaImage> {
    const blob = await this.gateway.thumbnail(item.baseUrl, maxSide);
    const bitmap = await createImageBitmap(blob);
    try {
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new PixError(ErrorCode.MediaDecodeFailed, "2D canvas unavailable");
      ctx.drawImage(bitmap, 0, 0);
      return LumaImage.fromRgba(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
    }
  }

  private static rgb(rgba: Uint8ClampedArray): Uint8Array {
    const out = new Uint8Array((rgba.length / 4) * 3);
    for (let i = 0; i < out.length / 3; i++) {
      out[i * 3] = rgba[i * 4]!;
      out[i * 3 + 1] = rgba[i * 4 + 1]!;
      out[i * 3 + 2] = rgba[i * 4 + 2]!;
    }
    return out;
  }

  private static async pixels(blob: Blob, side: number): Promise<Uint8ClampedArray> {
    const bitmap = await createImageBitmap(blob, { resizeWidth: side, resizeHeight: side, resizeQuality: "high" });
    try {
      const ctx = new OffscreenCanvas(side, side).getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new PixError(ErrorCode.MediaDecodeFailed, "2D canvas unavailable");
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, side, side).data;
    } finally {
      bitmap.close();
    }
  }
}
