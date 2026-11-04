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
