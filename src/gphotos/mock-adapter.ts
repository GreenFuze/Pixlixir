/**
 * In-memory adapter for tests and offline UI work. Never claims live success:
 * every created item's URL points at a mock:// scheme.
 */

import type { AccountRef, AlbumRef, Capability, CreatedMediaItem, ItemDetails, LibraryItem, MediaItemInfo, Page, DateChange, ItemFileInfo } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";
import type { LibraryCursor, PhotosLibraryAdapter, UploadOptions } from "./adapter.js";

export interface MockUploadRecord {
  fileName: string;
  bytes: Uint8Array;
  options: UploadOptions;
  mediaKey: string;
}

export class MockPhotosAdapter implements PhotosLibraryAdapter {
  readonly uploads: MockUploadRecord[] = [];
  readonly originals = new Map<string, Uint8Array>();
  readonly thumbnails = new Map<string, Uint8Array>();
  readonly albums: AlbumRef[] = [];
  readonly albumItems = new Map<string, string[]>();
  readonly details = new Map<string, Omit<ItemDetails, "mediaKey" | "dedupKey">>();
  readonly albumAdds: { mediaKeys: string[]; album: AlbumRef }[] = [];
  readonly descriptions = new Map<string, string>();
  /** Page size for listings (small, so tests exercise paging). */
  pageSize = 3;
  readonly #items = new Map<string, MediaItemInfo>();
  #failNextUpload: PixError | null = null;

  constructor(readonly account: AccountRef) {}

  addItem(item: MediaItemInfo): void {
    if (item.ref.accountEmail !== this.account.email) {
      throw new PixError(ErrorCode.AccountMismatch, "Mock item belongs to a different account", { item: item.ref, account: this.account.email });
    }
    this.#items.set(item.ref.mediaKey, item);
  }

  failNextUpload(error: PixError): void {
    this.#failNextUpload = error;
  }

  async getItem(mediaKey: string): Promise<MediaItemInfo> {
    const item = this.#items.get(mediaKey);
    if (!item) throw new PixError(ErrorCode.RpcEnvelopeMissing, `Mock item not found: ${mediaKey}`, { mediaKey });
    return item;
  }

  async downloadOriginal(mediaKey: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    await this.getItem(mediaKey);
    const bytes = this.originals.get(mediaKey);
    if (!bytes) throw new PixError(ErrorCode.MediaFetchFailed, `Mock original not registered: ${mediaKey}`, { mediaKey });
    return { bytes, mimeType: "image/jpeg" };
  }

  async uploadPhoto(bytes: Uint8Array, fileName: string, options: UploadOptions): Promise<CreatedMediaItem> {
    if (this.#failNextUpload) {
      const err = this.#failNextUpload;
      this.#failNextUpload = null;
      throw err;
    }
    const mediaKey = `mock-${this.uploads.length + 1}`;
    this.uploads.push({ fileName, bytes, options, mediaKey });
    return { ref: { accountEmail: this.account.email, mediaKey }, dedupKey: `dedup-${mediaKey}`, width: 0, height: 0, webUrl: `mock://photo/${mediaKey}` };
  }

  async listLibrary(cursor: LibraryCursor): Promise<Page<LibraryItem>> {
    // Like the live token, the page token remembers where the listing started.
    const [startText, offset] = cursor.page === null ? [cursor.startMs === null ? "" : String(cursor.startMs), null] : cursor.page.split("@");
    const startMs = startText ? Number(startText) : null;
    const all = [...this.#items.values()].sort((a, b) => b.takenAtMs - a.takenAtMs).filter((i) => startMs === null || i.takenAtMs <= startMs);
    const r = this.page(all.map((i) => this.listed(i)), offset ?? null);
    return { items: r.items, next: r.next === null ? null : `${startText}@${r.next}` };
  }

  async listAlbums(page: string | null): Promise<Page<AlbumRef>> {
    return this.page(this.albums, page);
  }

  async listAlbumItems(albumKey: string, page: string | null): Promise<Page<LibraryItem>> {
    const keys = this.albumItems.get(albumKey);
    if (!keys) throw new PixError(ErrorCode.RpcEnvelopeMissing, `Mock album not found: ${albumKey}`, { albumKey });
    return this.page(await Promise.all(keys.map(async (k) => this.listed(await this.getItem(k)))), page);
  }

  async getItemDetails(mediaKey: string): Promise<ItemDetails> {
    const item = await this.getItem(mediaKey);
    const extra = this.details.get(mediaKey) ?? { description: "", albums: [], location: null, camera: null };
    return { mediaKey, dedupKey: item.dedupKey, ...extra };
  }

  async readItemInfo(mediaKeys: readonly string[]): Promise<ItemFileInfo[]> {
    return [...this.#items.values()].filter((i) => mediaKeys.includes(i.ref.mediaKey)).map((i) => ({ mediaKey: i.ref.mediaKey, fileName: i.fileName, takenAtMs: i.takenAtMs, timezoneOffsetMs: i.timezoneOffsetMs }));
  }

  async setDates(changes: readonly DateChange[]): Promise<void> {
    for (const change of changes) {
      const item = [...this.#items.values()].find((i) => i.dedupKey === change.dedupKey);
      if (!item) throw new PixError(ErrorCode.RpcEnvelopeMissing, "Mock item not found for a date change", { dedupKey: change.dedupKey });
      this.#items.set(item.ref.mediaKey, { ...item, takenAtMs: change.takenAtMs, timezoneOffsetMs: change.timezoneOffsetMs });
    }
  }

  async fetchThumbnail(baseUrl: string, _maxSide: number): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const item = [...this.#items.values()].find((i) => i.baseUrl === baseUrl);
    const bytes = item ? (this.thumbnails.get(item.ref.mediaKey) ?? this.originals.get(item.ref.mediaKey)) : undefined;
    if (!bytes) throw new PixError(ErrorCode.MediaFetchFailed, "Mock thumbnail not registered", { baseUrl });
    return { bytes, mimeType: "image/jpeg" };
  }

  async addToAlbum(mediaKeys: readonly string[], album: AlbumRef): Promise<void> {
    this.albumAdds.push({ mediaKeys: [...mediaKeys], album });
  }

  async setDescription(dedupKey: string, description: string): Promise<void> {
    this.descriptions.set(dedupKey, description);
  }

  private listed(i: MediaItemInfo): LibraryItem {
    return { mediaKey: i.ref.mediaKey, dedupKey: i.dedupKey, type: i.type, width: i.width, height: i.height, takenAtMs: i.takenAtMs, timezoneOffsetMs: i.timezoneOffsetMs, baseUrl: i.baseUrl, location: this.details.get(i.ref.mediaKey)?.location ?? null };
  }

  private page<T>(all: readonly T[], token: string | null): Page<T> {
    const start = token === null ? 0 : Number(token);
    const end = start + this.pageSize;
    return { items: all.slice(start, end), next: end < all.length ? String(end) : null };
  }

  capabilities(): Capability[] {
    return [{ id: "mock", label: "Mock adapter", status: "implemented-unverified", verifiedOn: null, notes: "Not connected to Google Photos." }];
  }
}
