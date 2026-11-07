/**
 * What a photo's own file says about when it was taken, read from the start of the file. Measured on
 * the owner's library (ADR-0007): all 213 known copies carry a date that is never their name's date,
 * so a file that disagrees with its name is a copy. A file with no date says nothing: WhatsApp and
 * others strip it even when the name is right.
 */

import piexif from "piexifjs";
import { ExifCarry } from "../imaging/edit/exif-carry.js";

export interface FileDetails {
  /** The date taken in the file, as wall-clock time written as if it were UTC. Null when it has none. */
  takenLocalMs: number | null;
  /** The file names a camera. */
  camera: boolean;
  /** The program that last saved it. */
  software: string | null;
}

export type NameVerdict = "agrees" | "disagrees" | "unknown";

export class FileDetailsReader {
  private static readonly DAY_MS = 86_400_000;
  private static readonly DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

  /** Null when the head holds no EXIF that can be read: not every file is a JPEG, and that is not an error here. */
  static parse(head: Uint8Array): FileDetails | null {
    let exif: ReturnType<typeof piexif.load>;
    try {
      exif = piexif.load(ExifCarry.toBinary(head));
    } catch {
      return null;
    }
    const text = (value: unknown) => (typeof value === "string" ? value.replace(/\0+$/, "").trim() : "");
    const zeroth = exif["0th"] ?? {};
    return {
      takenLocalMs: FileDetailsReader.wallClock(text((exif.Exif ?? {})[piexif.ExifIFD.DateTimeOriginal])),
      camera: text(zeroth[piexif.ImageIFD.Make]) !== "" || text(zeroth[piexif.ImageIFD.Model]) !== "",
      software: text(zeroth[piexif.ImageIFD.Software]) || null,
    };
  }

  /** Whether the file's own date backs the name. A day either way allows for time zones. */
  static compare(details: FileDetails | null, nameLocalMs: number): NameVerdict {
    if (details?.takenLocalMs === null || details?.takenLocalMs === undefined) return "unknown";
    return Math.abs(details.takenLocalMs - nameLocalMs) <= 1.5 * FileDetailsReader.DAY_MS ? "agrees" : "disagrees";
  }

  private static wallClock(text: string): number | null {
    const g = FileDetailsReader.DATE.exec(text);
    if (!g) return null;
    const [year, month, day, hour, minute, second] = g.slice(1).map(Number) as [number, number, number, number, number, number];
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const d = new Date(ms);
    return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ms : null;
  }
}
