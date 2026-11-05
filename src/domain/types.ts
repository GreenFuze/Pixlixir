/**
 * Stable domain model. Deliberately independent of Google Photos' private
 * response formats: the gphotos adapter translates into these types.
 */

/** A Google account as seen through a signed-in photos.google.com tab. */
export interface AccountRef {
  /** Signed-in email. The stable identity key for binding. */
  email: string;
  /** Google account numeric id, when the page exposes it. */
  gaiaId: string | null;
  /** Multi-login index from the `/u/N/` URL prefix (0 when absent). Can change between sessions. */
  authUserIndex: number;
}

export type MediaType = "photo" | "video" | "unknown";

/** Namespaced media reference: Google media keys are only meaningful within one account. */
export interface MediaRef {
  accountEmail: string;
  mediaKey: string;
}

export interface MediaItemInfo {
  ref: MediaRef;
  /** Key used by mutation RPCs (differs from mediaKey). */
  dedupKey: string;
  type: MediaType;
  width: number;
  height: number;
  /** Capture timestamp, epoch ms. */
  takenAtMs: number;
  /** Timezone offset of the capture, ms. */
  timezoneOffsetMs: number;
  /** Base content URL; size suffixes (=w..-h.., =d) select renditions. */
  baseUrl: string;
  fileName: string | null;
  sizeBytes: number | null;
}

/** A point on Earth in decimal degrees. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** One item as listed by a library/album page (cheap: no per-item request). */
export interface LibraryItem {
  mediaKey: string;
  dedupKey: string;
  type: MediaType;
  width: number;
  height: number;
  takenAtMs: number;
  timezoneOffsetMs: number;
  /** Base content URL (renditions via RenditionUrl). */
  baseUrl: string;
  /** Location Google Photos shows for the item, if any. */
  location: GeoPoint | null;
  /** False for items in the library that belong to someone else (partner sharing). */
  editable?: boolean;
}

/** What a bulk read returns for an item. */
export interface ItemFileInfo {
  mediaKey: string;
  fileName: string | null;
  takenAtMs: number;
  timezoneOffsetMs: number;
  /** When Google reports it. */
  sizeBytes?: number;
}

/** A capture date to write on an item. */
export interface DateChange {
  dedupKey: string;
  takenAtMs: number;
  timezoneOffsetMs: number;
}

/** A page of a paged listing; `next` is null on the last page. */
export interface Page<T> {
  items: T[];
  next: string | null;
}

export interface AlbumRef {
  mediaKey: string;
  title: string;
  /** Shared albums are visible to other people. */
  shared: boolean;
}

/** Per-item details beyond the listing (one request per item). */
export interface ItemDetails {
  mediaKey: string;
  dedupKey: string;
  description: string;
  albums: AlbumRef[];
  location: GeoPoint | null;
  camera: { make: string | null; model: string | null } | null;
}

/** Result of committing a new upload to the library. */
export interface CreatedMediaItem {
  ref: MediaRef;
  dedupKey: string;
  width: number;
  height: number;
  /** URL the user can open to see the item. */
  webUrl: string;
}

/** Capability honesty: what we know about each library operation. */
export type CapabilityStatus = "live-verified" | "implemented-unverified" | "research" | "blocked";

export interface Capability {
  id: string;
  label: string;
  status: CapabilityStatus;
  /** ISO date of the last live verification, or null. */
  verifiedOn: string | null;
  notes: string;
}
