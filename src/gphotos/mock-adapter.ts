/**
 * In-memory adapter for tests and offline UI work. Never claims live success:
 * every created item's URL points at a mock:// scheme.
 */

import type { AccountRef, Capability, CreatedMediaItem, MediaItemInfo } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";
import type { PhotosLibraryAdapter, UploadOptions } from "./adapter.js";

export interface MockUploadRecord {
  fileName: string;
  bytes: Uint8Array;
  options: UploadOptions;
  mediaKey: string;
}

export class MockPhotosAdapter implements PhotosLibraryAdapter {
  readonly uploads: MockUploadRecord[] = [];
  readonly originals = new Map<string, Uint8Array>();
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

  capabilities(): Capability[] {
    return [{ id: "mock", label: "Mock adapter", status: "implemented-unverified", verifiedOn: null, notes: "Not connected to Google Photos." }];
  }
}
