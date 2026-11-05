/**
 * Typed wrappers over individual Google Photos private RPCs.
 *
 * PRIVATE PROTOCOL. RPC ids and positional indices are documented, with the
 * date and method of verification, in docs/feasibility/google-photos-protocol.md.
 * Nothing outside src/gphotos may reference RPC ids or indices.
 */

import type { AlbumRef, GeoPoint, ItemDetails, LibraryItem, MediaType, Page } from "../../domain/types.js";
import type { BatchExecuteClient } from "./batchexecute.js";
import { PositionalReader } from "./positional.js";

export const RpcId = {
  getItemInfo: "VrseUb",
  getItemInfoExt: "fDcn4b",
  commitUpload: "mdpdU",
  setTimestamps: "DaSgWe",
  listLibrary: "lcxiM",
  listAlbums: "Z5xsfc",
  albumPage: "snAcKc",
  addToAlbum: "E1Cajb",
  addToSharedAlbum: "laUYf",
  setDescription: "AQNOFd",
} as const;

/** Ext-object key that marks video items (GPTK, observed in lcxiM/VrseUb). */
const VIDEO_EXT_KEY = "76647426";
/** Ext-object key holding an item's location in listings (live-verified 2026-11-05). */
const GEO_EXT_KEY = "129168200";
/** Ext-object key holding album metadata in album listings (live-verified 2026-11-05). */
const ALBUM_EXT_KEY = "72930366";

/**
 * Parsers shared by every listing RPC. Item rows (lcxiM, snAcKc) look like
 * [mediaKey, [baseUrl, w, h, …], takenMs, dedupKey, tzMs, …, {ext}].
 */
export class ListingParser {
  static item(rpcId: string, row: unknown): LibraryItem {
    const r = new PositionalReader(rpcId, row);
    const ext = ListingParser.ext(row);
    return {
      mediaKey: r.string([0], "item.mediaKey"),
      baseUrl: r.string([1, 0], "item.baseUrl"),
      width: r.number([1, 1], "item.width"),
      height: r.number([1, 2], "item.height"),
      takenAtMs: r.number([2], "item.takenAt"),
      dedupKey: r.string([3], "item.dedupKey"),
      timezoneOffsetMs: r.optionalNumber([4]) ?? 0,
      type: ext && VIDEO_EXT_KEY in ext ? "video" : "photo",
      location: ListingParser.geo(new PositionalReader(rpcId, ext).at([GEO_EXT_KEY, 1, 0])),
    };
  }

  static album(rpcId: string, row: unknown): AlbumRef {
    const r = new PositionalReader(rpcId, row);
    const ext = ListingParser.ext(row);
    const meta = new PositionalReader(rpcId, ext);
    return {
      mediaKey: r.string([0], "album.mediaKey"),
      title: meta.optionalString([ALBUM_EXT_KEY, 1]) ?? "Untitled album",
      shared: Boolean(meta.at([ALBUM_EXT_KEY, 4])),
    };
  }

  /** [latitudeE7, longitudeE7] -> degrees, or null when absent. */
  static geo(v: unknown): GeoPoint | null {
    if (!Array.isArray(v) || typeof v[0] !== "number" || typeof v[1] !== "number") return null;
    return { latitude: v[0] / 1e7, longitude: v[1] / 1e7 };
  }

  static nextPage(v: unknown): string | null {
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  /** The trailing object of a row, which carries keyed extensions. */
  private static ext(row: unknown): Record<string, unknown> | null {
    const last = Array.isArray(row) ? row[row.length - 1] : null;
    return last && typeof last === "object" && !Array.isArray(last) ? (last as Record<string, unknown>) : null;
  }
}

export interface RawItemInfo {
  mediaKey: string;
  dedupKey: string;
  baseUrl: string;
  width: number;
  height: number;
  takenAtMs: number;
  timezoneOffsetMs: number;
  type: MediaType;
}

export interface RawItemExtInfo {
  fileName: string | null;
  sizeBytes: number | null;
}

export interface RawCommittedUpload {
  mediaKey: string;
  dedupKey: string;
  width: number;
  height: number;
}

export class PhotosRpc {
  constructor(private readonly client: BatchExecuteClient) {}

  /** VrseUb — core item info. Live-verified 2026-11-04 (read-only). */
  async getItemInfo(mediaKey: string): Promise<RawItemInfo> {
    const data = await this.client.call(RpcId.getItemInfo, [mediaKey, null, null, null, null]);
    const r = new PositionalReader(RpcId.getItemInfo, data);
    const item = r.array([0], "item");
    const isVideo = item.some((x) => typeof x === "object" && x !== null && !Array.isArray(x) && VIDEO_EXT_KEY in x);
    return {
      mediaKey: r.string([0, 0], "mediaKey"),
      baseUrl: r.string([0, 1, 0], "baseUrl"),
      width: r.number([0, 1, 1], "width"),
      height: r.number([0, 1, 2], "height"),
      takenAtMs: r.number([0, 2], "takenAt"),
      dedupKey: r.string([0, 3], "dedupKey"),
      timezoneOffsetMs: r.optionalNumber([0, 4]) ?? 0,
      type: isVideo ? "video" : "photo",
    };
  }

  /** fDcn4b — extended info (file name, size). Own-library items only. Live-verified 2026-11-04. */
  async getItemInfoExt(mediaKey: string): Promise<RawItemExtInfo> {
    const data = await this.client.call(RpcId.getItemInfoExt, [mediaKey, 1, null, null, 1]);
    const r = new PositionalReader(RpcId.getItemInfoExt, data);
    return { fileName: r.optionalString([0, 2]), sizeBytes: r.optionalNumber([0, 5]) };
  }

  /**
   * lcxiM — library timeline, newest first, 500 per page. `startMs` starts the listing at
   * that capture time (inclusive, going back); `pageId` continues a previous page.
   * Live-verified 2026-11-05 (read-only): ordering, paging and start-time semantics.
   */
  async listLibrary(pageId: string | null, startMs: number | null, pageSize = 500): Promise<Page<LibraryItem>> {
    const data = await this.client.call(RpcId.listLibrary, [pageId, startMs, pageSize, null, 1, 3]);
    const r = new PositionalReader(RpcId.listLibrary, data);
    const rows = r.at([0]);
    return { items: Array.isArray(rows) ? rows.map((row) => ListingParser.item(RpcId.listLibrary, row)) : [], next: ListingParser.nextPage(r.at([1])) };
  }

  /** Z5xsfc — the user's albums. Live-verified 2026-11-05 (read-only). */
  async listAlbums(pageId: string | null): Promise<Page<AlbumRef>> {
    const data = await this.client.call(RpcId.listAlbums, [pageId, null, null, null, 1, null, null, 100, [2], 5]);
    const r = new PositionalReader(RpcId.listAlbums, data);
    const rows = r.at([0]);
    return { items: Array.isArray(rows) ? rows.map((row) => ListingParser.album(RpcId.listAlbums, row)) : [], next: ListingParser.nextPage(r.at([1])) };
  }

  /** snAcKc — items of one album. Live-verified 2026-11-05 (read-only). */
  async albumPage(albumKey: string, pageId: string | null): Promise<Page<LibraryItem>> {
    const data = await this.client.call(RpcId.albumPage, [albumKey, pageId, null, null]);
    const r = new PositionalReader(RpcId.albumPage, data);
    const rows = r.at([1]);
    return { items: Array.isArray(rows) ? rows.map((row) => ListingParser.item(RpcId.albumPage, row)) : [], next: ListingParser.nextPage(r.at([2])) };
  }

  /** fDcn4b — description, albums, location and camera of an own item. Live-verified 2026-11-05 (read-only). */
  async getItemDetails(mediaKey: string): Promise<ItemDetails> {
    const data = await this.client.call(RpcId.getItemInfoExt, [mediaKey, 1, null, null, 1]);
    const r = new PositionalReader(RpcId.getItemInfoExt, data);
    const albums = r.at([0, 19]);
    const camera = r.at([0, 23]);
    return {
      mediaKey: r.string([0, 0], "mediaKey"),
      dedupKey: r.string([0, 11], "dedupKey"),
      description: typeof r.at([0, 1]) === "string" ? (r.at([0, 1]) as string) : "",
      albums: Array.isArray(albums) ? albums.map((a) => ListingParser.album(RpcId.getItemInfoExt, a)) : [],
      location: ListingParser.geo(r.at([0, 13, 0])) ?? ListingParser.geo(r.at([0, 9, 0])),
      camera: Array.isArray(camera) ? { make: typeof camera[0] === "string" ? camera[0] : null, model: typeof camera[1] === "string" ? camera[1] : null } : null,
    };
  }

  /** E1Cajb — add items to one of the user's (unshared) albums. Format per GPTK; see the protocol doc for status. */
  async addToAlbum(mediaKeys: readonly string[], albumKey: string): Promise<void> {
    await this.client.call(RpcId.addToAlbum, [mediaKeys, albumKey]);
  }

  /** laUYf — add items to a shared album. Format per GPTK; see the protocol doc for status. */
  async addToSharedAlbum(mediaKeys: readonly string[], albumKey: string): Promise<void> {
    await this.client.call(RpcId.addToSharedAlbum, [albumKey, [2, null, mediaKeys.map((k) => [[k]]), null, null, null, [1]]]);
  }

  /** AQNOFd — set an item's description. Format per GPTK; see the protocol doc for status. */
  async setDescription(dedupKey: string, description: string): Promise<void> {
    await this.client.call(RpcId.setDescription, [null, description, dedupKey]);
  }

  /** mdpdU — commit an uploaded blob as a new library item. Format captured live 2026-11-04. */
  async commitUpload(uploadToken: string, fileName: string, clientTimeMs: number): Promise<RawCommittedUpload> {
    const data = await this.client.call(RpcId.commitUpload, [[[uploadToken, fileName, clientTimeMs, 2, 2]]]);
    const r = new PositionalReader(RpcId.commitUpload, data);
    return {
      mediaKey: r.string([0, 0, 1, 0], "mediaKey"),
      width: r.number([0, 0, 1, 1, 1], "width"),
      height: r.number([0, 0, 1, 1, 2], "height"),
      dedupKey: r.string([0, 0, 1, 3], "dedupKey"),
    };
  }

  /** DaSgWe — set capture time (seconds) and timezone offset (seconds) on owned items. */
  async setTimestamps(items: readonly { dedupKey: string; takenAtMs: number; timezoneOffsetMs: number }[]): Promise<void> {
    const payload = [items.map((i) => [i.dedupKey, Math.round(i.takenAtMs / 1000), Math.round(i.timezoneOffsetMs / 1000)])];
    await this.client.call(RpcId.setTimestamps, payload);
  }
}
