/**
 * Lists the items a scan looks through, page by page, for any ScanScope.
 * Read-only: it only lists items and reads item info.
 */

import type { LibraryItem, MediaItemInfo, Page } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";
import type { ScanScope } from "./scan-scope.js";

/** The library calls a catalog needs (PhotosGateway in the extension, mocks in tests). */
export interface CatalogSource {
  listLibrary(page: string | null, startMs: number | null): Promise<Page<LibraryItem>>;
  listAlbumItems(albumKey: string, page: string | null): Promise<Page<LibraryItem>>;
  getItem(mediaKey: string): Promise<MediaItemInfo>;
}

export class LibraryCatalog {
  constructor(private readonly source: CatalogSource) {}

  /** Every item in scope (photos and videos), reporting the running count. */
  async collect(scope: ScanScope, onCount: (count: number) => void, signal: AbortSignal): Promise<LibraryItem[]> {
    const out: LibraryItem[] = [];
    for await (const page of this.pages(scope, signal)) {
      out.push(...page);
      onCount(out.length);
    }
    return out;
  }

  async *pages(scope: ScanScope, signal: AbortSignal): AsyncGenerator<LibraryItem[]> {
    switch (scope.kind) {
      case "library":
        yield* this.timeline(null, null, signal);
        return;
      case "dateRange":
        yield* this.timeline(scope.toMs, scope.fromMs, signal);
        return;
      case "album": {
        let page: string | null = null;
        do {
          LibraryCatalog.checkAborted(signal);
          const r: Page<LibraryItem> = await this.source.listAlbumItems(scope.album.mediaKey, page);
          yield r.items;
          page = r.next;
        } while (page !== null);
        return;
      }
      case "selection":
        for (let i = 0; i < scope.mediaKeys.length; i += LibraryCatalog.SELECTION_BATCH) {
          LibraryCatalog.checkAborted(signal);
          const keys = scope.mediaKeys.slice(i, i + LibraryCatalog.SELECTION_BATCH);
          yield await Promise.all(keys.map(async (k) => LibraryCatalog.fromInfo(await this.source.getItem(k))));
        }
        return;
    }
  }

  /** Newest-first timeline from `startMs` (or now), stopping at items older than `stopBeforeMs`. */
  private async *timeline(startMs: number | null, stopBeforeMs: number | null, signal: AbortSignal): AsyncGenerator<LibraryItem[]> {
    let page: string | null = null;
    let first = true;
    while (first || page !== null) {
      LibraryCatalog.checkAborted(signal);
      const r: Page<LibraryItem> = await this.source.listLibrary(page, first ? startMs : null);
      first = false;
      const inRange = stopBeforeMs === null ? r.items : r.items.filter((i) => i.takenAtMs >= stopBeforeMs);
      if (inRange.length > 0) yield inRange;
      if (inRange.length < r.items.length) return; // reached items older than the range
      page = r.next;
    }
  }

  static fromInfo(i: MediaItemInfo): LibraryItem {
    return { mediaKey: i.ref.mediaKey, dedupKey: i.dedupKey, type: i.type, width: i.width, height: i.height, takenAtMs: i.takenAtMs, timezoneOffsetMs: i.timezoneOffsetMs, baseUrl: i.baseUrl, location: null };
  }

  private static checkAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new PixError(ErrorCode.Cancelled, "The scan was stopped");
  }

  /** Selection items are looked up a few at a time. */
  static readonly SELECTION_BATCH = 6;
}
