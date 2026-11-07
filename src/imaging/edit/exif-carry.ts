/**
 * Moves a photo's EXIF to its edited copy, so camera details, time and GPS survive (Google reads the
 * location from the file). Orientation becomes 1 because the pixels are already upright, and the
 * thumbnail goes because it would still show what was erased.
 */

import piexif from "piexifjs";
import { ErrorCode, PixError } from "../../shared/errors.js";

export class ExifCarry {
  /** The edited JPEG with the source's EXIF. `sourceHead` holds the start of the original file. */
  static apply(edited: Uint8Array, sourceHead: Uint8Array): Uint8Array {
    try {
      const exif = piexif.load(ExifCarry.toBinary(sourceHead));
      exif["0th"][piexif.ImageIFD.Orientation] = 1;
      exif["1st"] = {};
      delete exif.thumbnail;
      return ExifCarry.fromBinary(piexif.insert(piexif.dump(exif), ExifCarry.toBinary(edited)));
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.MetadataNotCopied, "Saved, but camera details and location were not copied");
    }
  }

  static toBinary(bytes: Uint8Array): string {
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    return parts.join("");
  }

  private static fromBinary(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }
}
