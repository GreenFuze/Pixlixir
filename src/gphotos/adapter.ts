/**
 * Google Photos library adapter contract.
 *
 * Feature code depends only on this interface and the domain types. The live
 * implementation (LiveWebAdapter) is the only place that touches the private
 * web protocol; MockPhotosAdapter backs tests and offline UI development.
 */

import type { AccountRef, AlbumRef, Capability, CreatedMediaItem, DateChange, ItemDetails, ItemFileInfo, LibraryItem, MediaItemInfo, Page } from "../domain/types.js";

export interface UploadOptions {
  /** If set, the created item's capture time is set to this (keeps it next to its source in the timeline). */
  takenAtMs?: number;
  timezoneOffsetMs?: number;
}

/** Where to continue a library listing: a page token, or a capture time to start from (newest first). */
export interface LibraryCursor {
  page: string | null;
  startMs: number | null;
}

export interface PhotosLibraryAdapter {
  readonly account: AccountRef;
  getItem(mediaKey: string): Promise<MediaItemInfo>;
  /** Full-resolution bytes of a photo. */
  downloadOriginal(mediaKey: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** The start of a photo's file, where its details are, without downloading the rest. */
  fetchFileHead(baseUrl: string): Promise<Uint8Array>;
  uploadPhoto(bytes: Uint8Array, fileName: string, options: UploadOptions): Promise<CreatedMediaItem>;

  // ---- reading the library (read-only) ----
  listLibrary(cursor: LibraryCursor): Promise<Page<LibraryItem>>;
  listAlbums(page: string | null): Promise<Page<AlbumRef>>;
  listAlbumItems(albumKey: string, page: string | null): Promise<Page<LibraryItem>>;
  getItemDetails(mediaKey: string): Promise<ItemDetails>;
  /** File names and dates of many items in one call. */
  readItemInfo(mediaKeys: readonly string[]): Promise<ItemFileInfo[]>;
  /** A resized JPEG of an item, from a base URL returned by a listing. */
  fetchThumbnail(baseUrl: string, maxSide: number): Promise<{ bytes: Uint8Array; mimeType: string }>;

  // ---- organising new items (never changes existing photos) ----
  addToAlbum(mediaKeys: readonly string[], album: AlbumRef): Promise<void>;
  setDescription(dedupKey: string, description: string): Promise<void>;

  // ---- repairing metadata (changes existing items in place, only after the user confirms) ----
  setDates(changes: readonly DateChange[]): Promise<void>;

  // ---- trash (always recoverable from Google's Trash; there is no permanent delete here) ----
  moveToTrash(dedupKeys: readonly string[]): Promise<void>;
  /** Dedup keys of one page of the trash. */
  listTrash(page: string | null): Promise<Page<string>>;

  capabilities(): Capability[];
}

/**
 * Base URLs handed to fetchThumbnail must point at Google's image hosts (never an arbitrary URL).
 * Live listings use photos.fife.usercontent.google.com/pw/… (verified 2026-11-05);
 * *.googleusercontent.com is the older form still seen in other responses.
 */
export const CONTENT_URL = /^https:\/\/(?:[a-z0-9-]+\.googleusercontent\.com|[a-z0-9.-]+\.usercontent\.google\.com)\/[^\s]+$/;

export type Rendition = { kind: "original" } | { kind: "fit"; maxWidth: number; maxHeight: number };

/**
 * Builds content URLs from an item base URL. `=d` live-verified for photos 2026-11-04.
 * These URLs require the user's Google cookies (403 without), so they must be
 * fetched from the Photos origin with credentials.
 */
export class RenditionUrl {
  static build(baseUrl: string, rendition: Rendition): string {
    const suffix = rendition.kind === "original" ? "d" : `w${Math.round(rendition.maxWidth)}-h${Math.round(rendition.maxHeight)}`;
    return `${baseUrl}=${suffix}`;
  }
}

/** Web URL of an item for a given account. */
export function itemWebUrl(account: AccountRef, mediaKey: string): string {
  const prefix = account.authUserIndex > 0 ? `/u/${account.authUserIndex}` : "";
  return `https://photos.google.com${prefix}/photo/${encodeURIComponent(mediaKey)}`;
}
