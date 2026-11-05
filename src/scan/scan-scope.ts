/**
 * What a library scan looks through. Shared by every detector (panoramas today;
 * metadata, duplicates and more later).
 */

import type { AlbumRef } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";

export type ScanScope =
  /** Capture time between fromMs and toMs (inclusive, epoch ms). */
  | { kind: "dateRange"; fromMs: number; toMs: number }
  | { kind: "album"; album: AlbumRef }
  | { kind: "selection"; mediaKeys: string[] }
  | { kind: "library" };

export type ScanScopeKind = ScanScope["kind"];

export class ScanScopes {
  static validate(scope: ScanScope): ScanScope {
    if (scope.kind === "dateRange" && !(Number.isFinite(scope.fromMs) && Number.isFinite(scope.toMs) && scope.fromMs <= scope.toMs)) {
      throw new PixError(ErrorCode.InvalidMessage, "Choose a start date that is on or before the end date.", { fromMs: scope.fromMs, toMs: scope.toMs });
    }
    if (scope.kind === "selection" && scope.mediaKeys.length === 0) {
      throw new PixError(ErrorCode.InvalidMessage, "No photos were selected. Select photos in Google Photos first, or choose another scope.");
    }
    return scope;
  }

  static describe(scope: ScanScope): string {
    switch (scope.kind) {
      case "dateRange": {
        const f = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
        return `Photos from ${f(scope.fromMs)} to ${f(scope.toMs)}`;
      }
      case "album":
        return `Album “${scope.album.title}”`;
      case "selection":
        return `${scope.mediaKeys.length} selected photo${scope.mediaKeys.length === 1 ? "" : "s"}`;
      case "library":
        return "Your whole library";
    }
  }
}
