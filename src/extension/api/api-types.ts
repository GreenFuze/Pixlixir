/**
 * The Local API's public shapes (docs/api/openapi.yaml, ADR-0012) and how Pixlixir's own types and
 * errors become them. Times are given in the place a photo was taken, with that place's offset.
 */

import type { AccountRef, AlbumRef, GeoPoint, ItemDetails, LibraryItem, MediaType } from "../../domain/types.js";
import { itemWebUrl } from "../../gphotos/adapter.js";
import { ErrorCode, PixError } from "../../shared/errors.js";

export const API_VERSION = "1.0.0";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN_ORIGIN"
  | "NOT_FOUND"
  | "ACCOUNT_REQUIRED"
  | "RATE_LIMITED"
  | "NOT_SUPPORTED"
  | "NO_PHOTOS_TAB"
  | "PIXLIXIR_NOT_CONNECTED"
  | "GOOGLE_ERROR"
  | "TIMEOUT"
  | "INTERNAL";

/** An error a caller of the API sees: a stable code, a message for people, and details. */
export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
  }

  toJSON(): { code: ApiErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }

  /** Pixlixir's errors in the API's words. `lookup` says a missing answer from Google means "not found". */
  static from(err: unknown, lookup = false): ApiError {
    if (err instanceof ApiError) return err;
    if (!(err instanceof PixError)) return new ApiError("INTERNAL", err instanceof Error ? err.message : String(err));
    switch (err.code) {
      case ErrorCode.RateLimited:
        return new ApiError("RATE_LIMITED", err.message, err.details ?? {});
      case ErrorCode.TabNotBound:
      case ErrorCode.SessionUnavailable:
      case ErrorCode.AccountMismatch:
        return new ApiError("NO_PHOTOS_TAB", err.message, err.details ?? {});
      case ErrorCode.InvalidImage:
        return new ApiError("NOT_SUPPORTED", err.message, err.details ?? {});
      case ErrorCode.InvalidMessage:
        return new ApiError("BAD_REQUEST", err.message, err.details ?? {});
      case ErrorCode.RpcEnvelopeMissing:
        return lookup ? new ApiError("NOT_FOUND", "No such item or album in this account.", err.details ?? {}) : new ApiError("GOOGLE_ERROR", err.message, err.details ?? {});
      case ErrorCode.RpcHttpError:
      case ErrorCode.RpcUnexpectedShape:
      case ErrorCode.MediaFetchFailed:
      case ErrorCode.MediaDecodeFailed:
        return new ApiError("GOOGLE_ERROR", err.message, err.details ?? {});
      default:
        return new ApiError("INTERNAL", err.message, { pixlixirCode: err.code, ...(err.details ?? {}) });
    }
  }
}

export interface ApiItem {
  mediaKey: string;
  type: MediaType;
  fileName: string | null;
  width: number;
  height: number;
  takenAt: string;
  takenAtMs: number;
  timezoneOffsetMinutes: number;
  sizeBytes: number | null;
  webUrl: string;
}

export interface ApiAlbum {
  albumKey: string;
  title: string;
  shared: boolean;
}

export interface ApiItemDetails extends ApiItem {
  description: string;
  albums: ApiAlbum[];
  location: GeoPoint | null;
  camera: { make: string | null; model: string | null } | null;
}

export interface ApiLibraryItem {
  mediaKey: string;
  type: MediaType;
  width: number;
  height: number;
  takenAt: string;
  takenAtMs: number;
  timezoneOffsetMinutes: number;
  location: GeoPoint | null;
  webUrl: string;
}

export class ApiShapes {
  /** RFC 3339 in the place it was taken: the instant shifted by the offset, then the offset written out. */
  static localTime(takenAtMs: number, timezoneOffsetMs: number): string {
    const minutes = Math.round(timezoneOffsetMs / 60_000);
    const local = new Date(takenAtMs + minutes * 60_000).toISOString().slice(0, 19);
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  }

  static album(a: AlbumRef): ApiAlbum {
    return { albumKey: a.mediaKey, title: a.title, shared: a.shared };
  }

  static libraryItem(account: AccountRef, i: LibraryItem): ApiLibraryItem {
    return {
      mediaKey: i.mediaKey, type: i.type, width: i.width, height: i.height,
      takenAt: ApiShapes.localTime(i.takenAtMs, i.timezoneOffsetMs), takenAtMs: i.takenAtMs, timezoneOffsetMinutes: Math.round(i.timezoneOffsetMs / 60_000),
      location: i.location, webUrl: itemWebUrl(account, i.mediaKey),
    };
  }

  static item(account: AccountRef, i: Pick<LibraryItem, "mediaKey" | "type" | "width" | "height" | "takenAtMs" | "timezoneOffsetMs">, file: { fileName: string | null; sizeBytes: number | null }): ApiItem {
    return {
      mediaKey: i.mediaKey, type: i.type, fileName: file.fileName, width: i.width, height: i.height,
      takenAt: ApiShapes.localTime(i.takenAtMs, i.timezoneOffsetMs), takenAtMs: i.takenAtMs, timezoneOffsetMinutes: Math.round(i.timezoneOffsetMs / 60_000),
      sizeBytes: file.sizeBytes, webUrl: itemWebUrl(account, i.mediaKey),
    };
  }

  static details(item: ApiItem, d: ItemDetails): ApiItemDetails {
    return { ...item, description: d.description, albums: d.albums.map(ApiShapes.album), location: d.location, camera: d.camera };
  }
}
