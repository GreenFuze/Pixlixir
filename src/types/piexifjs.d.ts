/** The parts of piexifjs we use. It has no type declarations of its own. */
declare module "piexifjs" {
  export interface ExifData {
    "0th": Record<number, unknown>;
    Exif: Record<number, unknown>;
    GPS: Record<number, unknown>;
    Interop: Record<number, unknown>;
    "1st": Record<number, unknown>;
    thumbnail?: string | null;
  }

  const piexif: {
    load(jpegBinary: string): ExifData;
    dump(exif: ExifData): string;
    insert(exifBinary: string, jpegBinary: string): string;
    ImageIFD: { Orientation: number; Make: number; Model: number; Software: number };
    ExifIFD: { DateTimeOriginal: number };
    GPSIFD: { GPSLatitude: number; GPSLatitudeRef: number; GPSLongitude: number; GPSLongitudeRef: number };
  };
  export default piexif;
}
