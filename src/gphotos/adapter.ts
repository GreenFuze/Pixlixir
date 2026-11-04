/**
 * Google Photos library adapter contract.
 *
 * Feature code depends only on this interface and the domain types. The live
 * implementation (LiveWebAdapter) is the only place that touches the private
 * web protocol; MockPhotosAdapter backs tests and offline UI development.
 */

import type { AccountRef, Capability, CreatedMediaItem, MediaItemInfo } from "../domain/types.js";

export interface UploadOptions {
  /** If set, the created item's capture time is set to this (keeps it next to its source in the timeline). */
  takenAtMs?: number;
  timezoneOffsetMs?: number;
}

export interface PhotosLibraryAdapter {
  readonly account: AccountRef;
  getItem(mediaKey: string): Promise<MediaItemInfo>;
  /** Full-resolution bytes of a photo. */
  downloadOriginal(mediaKey: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  uploadPhoto(bytes: Uint8Array, fileName: string, options: UploadOptions): Promise<CreatedMediaItem>;
  capabilities(): Capability[];
}

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
