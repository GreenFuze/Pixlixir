/**
 * Panorama building blocks shared by the Create-panorama editor and bulk creation from a scan:
 *
 * - PanoramaSourceLoader: original photo -> decoded into the engine (bounded memory), keeping
 *   the file's header so the panorama can inherit its EXIF;
 * - MetadataInheritance: what a panorama inherits from its photos (earliest capture time,
 *   location, description, albums), as Google Photos shows them;
 * - PanoramaPublisher: uploads the panorama as a new item and puts it in the same places.
 *
 * Source photos are never modified.
 */

import type { AlbumRef, CreatedMediaItem, GeoPoint, MediaItemInfo } from "../../../domain/types.js";
import type { OutputMetadata } from "../../../imaging/panorama/stitch-runtime.js";
import { ErrorCode, PixError, type SerializedError } from "../../../shared/errors.js";
import type { PhotosGateway } from "../photos-gateway.js";
import type { PanoramaWorkerClient } from "./panorama-client.js";

export interface LoadedSource {
  key: number;
  mediaKey: string;
  item: MediaItemInfo;
  /** First bytes of the original file (its EXIF header). */
  head: Uint8Array;
  thumb: Blob;
  size: { width: number; height: number };
  downscaled: boolean;
}

export class PanoramaSourceLoader {
  /** EXIF lives in APP1 (≤ 64 KB) near the start of a JPEG; this leaves room for APP0/APP2 before it. */
  static readonly HEAD_BYTES = 256 * 1024;

  constructor(
    private readonly gateway: PhotosGateway,
    private readonly worker: PanoramaWorkerClient,
    private readonly thumbnail: (blob: Blob) => Promise<Blob>,
  ) {}

  /** Downloads one original, shrinks it only if above `budgetMegapixels`, and loads it into the engine as `key`. */
  async load(key: number, mediaKey: string, budgetMegapixels: number): Promise<LoadedSource> {
    // Paragraph: item info + original bytes through the bound Photos tab.
    const item = await this.gateway.getItem(mediaKey);
    if (item.type === "video") throw new PixError(ErrorCode.InvalidImage, "Videos can't be used in a panorama yet.", { mediaKey });
    const blob = await this.gateway.downloadOriginal(mediaKey);

    // Paragraph: decode (EXIF orientation applied), shrinking only if over the memory budget.
    const probe = await createImageBitmap(blob).catch((err: unknown) => {
      throw PixError.wrap(err, ErrorCode.MediaDecodeFailed, `This browser can't decode ${item.fileName ?? "this photo"} (${blob.type}).`, { mimeType: blob.type });
    });
    const megapixels = (probe.width * probe.height) / 1e6;
    const scale = megapixels > budgetMegapixels ? Math.sqrt(budgetMegapixels / megapixels) : 1;
    let bitmap = probe;
    if (scale < 1) {
      bitmap = await createImageBitmap(blob, { resizeWidth: Math.round(probe.width * scale), resizeHeight: Math.round(probe.height * scale), resizeQuality: "high" });
      probe.close();
    }

    // Paragraph: keep the header and a thumbnail; the full bytes are released.
    const head = new Uint8Array(await blob.slice(0, PanoramaSourceLoader.HEAD_BYTES).arrayBuffer());
    const thumb = await this.thumbnail(blob);
    const size = await this.worker.load(key, bitmap);
    return { key, mediaKey, item, head, thumb, size, downscaled: scale < 1 };
  }

  /** Per-photo megapixel budget so a whole selection stays inside a tab's memory. */
  static budgetPerPhoto(count: number): number {
    return Math.max(12, PanoramaSourceLoader.INPUT_BUDGET_MEGAPIXELS / count);
  }

  /** Total input budget: photos are shrunk (and flagged) when a selection would exceed it. */
  static readonly INPUT_BUDGET_MEGAPIXELS = 400;
}

/** What a saved panorama inherits from its photos. */
export interface InheritedMetadata {
  /** The earliest photo (by capture time): the panorama takes its date and EXIF. */
  earliestMediaKey: string;
  takenAtMs: number;
  timezoneOffsetMs: number;
  /** The earliest photo's location, else the first located photo's (in capture order). */
  location: GeoPoint | null;
  /** The first non-empty description among the photos (in capture order), or "". */
  description: string;
  /** Every album that holds any of the photos. */
  albums: AlbumRef[];
}

export class MetadataInheritance {
  /** Reads each photo's details (one request each) and derives the inherited metadata. */
  static async collect(gateway: PhotosGateway, sources: readonly { mediaKey: string; takenAtMs: number; timezoneOffsetMs: number }[]): Promise<InheritedMetadata> {
    if (sources.length === 0) throw new PixError(ErrorCode.Internal, "A panorama needs at least one source photo");
    const ordered = [...sources].sort((a, b) => a.takenAtMs - b.takenAtMs);
    const details = [];
    for (const s of ordered) details.push(await gateway.getItemDetails(s.mediaKey));
    return MetadataInheritance.derive(ordered, details);
  }

  /** Pure derivation (unit-tested): `ordered` and `details` are in capture order. */
  static derive(
    ordered: readonly { mediaKey: string; takenAtMs: number; timezoneOffsetMs: number }[],
    details: readonly { description: string; albums: AlbumRef[]; location: GeoPoint | null }[],
  ): InheritedMetadata {
    const first = ordered[0]!;
    const albums = new Map<string, AlbumRef>();
    for (const d of details) for (const a of d.albums) if (!albums.has(a.mediaKey)) albums.set(a.mediaKey, a);
    return {
      earliestMediaKey: first.mediaKey,
      takenAtMs: first.takenAtMs,
      timezoneOffsetMs: first.timezoneOffsetMs,
      location: details.find((d) => d.location !== null)?.location ?? null,
      description: details.find((d) => d.description.trim().length > 0)?.description.trim() ?? "",
      albums: [...albums.values()],
    };
  }

  /** EXIF input for the engine: the earliest photo's header plus Google's time and location. */
  static outputMetadata(inherited: InheritedMetadata, earliestHead: Uint8Array | null, matchDate: boolean): OutputMetadata {
    return {
      sourceHead: earliestHead,
      takenAtMs: matchDate ? inherited.takenAtMs : null,
      timezoneOffsetMs: inherited.timezoneOffsetMs,
      location: inherited.location,
    };
  }
}

export interface PublishChoices {
  matchDate: boolean;
  /** Albums to add the panorama to (normally all inherited albums). */
  albums: AlbumRef[];
  copyDescription: boolean;
}

export interface PublishedPanorama {
  created: CreatedMediaItem;
  fileName: string;
  albumsAdded: AlbumRef[];
  descriptionSet: boolean;
  /** Steps after the upload that failed (the panorama itself was saved). */
  problems: SerializedError[];
}

export class PanoramaPublisher {
  static readonly MAX_UPLOAD_BYTES = 45 * 1024 * 1024;

  constructor(private readonly gateway: PhotosGateway) {}

  /** Uploads as a new item, then adds it to the albums and copies the description. */
  async publish(image: Blob, fileName: string, inherited: InheritedMetadata, choices: PublishChoices): Promise<PublishedPanorama> {
    // Paragraph: upload (the date is set right after the commit).
    if (image.size > PanoramaPublisher.MAX_UPLOAD_BYTES) {
      throw new PixError(ErrorCode.UploadFailed, "The panorama file is too large to upload from the browser. Choose a smaller output size.", { bytes: image.size, limit: PanoramaPublisher.MAX_UPLOAD_BYTES });
    }
    const created = await this.gateway.upload({
      bytes: new Uint8Array(await image.arrayBuffer()),
      fileName,
      ...(choices.matchDate ? { takenAtMs: inherited.takenAtMs, timezoneOffsetMs: inherited.timezoneOffsetMs } : {}),
    });

    // Paragraph: same places and description. Each failure is reported; the saved item stays.
    const problems: SerializedError[] = [];
    const albumsAdded: AlbumRef[] = [];
    for (const album of choices.albums) {
      try {
        await this.gateway.addToAlbum([created.ref.mediaKey], album);
        albumsAdded.push(album);
      } catch (err) {
        problems.push(PixError.wrap(err, ErrorCode.UploadFailed, `Saved, but could not add it to the album “${album.title}”`, { album: album.title }).toJSON());
      }
    }
    let descriptionSet = false;
    if (choices.copyDescription && inherited.description.length > 0) {
      try {
        await this.gateway.setDescription(created.dedupKey, inherited.description);
        descriptionSet = true;
      } catch (err) {
        problems.push(PixError.wrap(err, ErrorCode.UploadFailed, "Saved, but could not copy the description").toJSON());
      }
    }
    return { created, fileName, albumsAdded, descriptionSet, problems };
  }

  static outputName(sourceName: string | null): string {
    const base = (sourceName ?? "photos").replace(/\.[^.]+$/, "").replace(/[^\w\- .]+/g, "_").slice(0, 80) || "photos";
    return `${base}_panorama.jpg`;
  }
}
