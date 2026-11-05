/**
 * The bound Google Photos tab, seen from an extension page (editor, scan).
 *
 * Every call re-resolves a live Photos tab signed in as the bound account (never another
 * account) and addresses the operation to that account, so a reloaded or replaced tab
 * keeps working and an account switch fails loudly instead of touching the wrong library.
 */

import type { AlbumRef, CreatedMediaItem, ItemDetails, LibraryItem, MediaItemInfo, Page, DateChange, ItemFileInfo } from "../../domain/types.js";
import { Base64 } from "../../shared/codec.js";
import { Messenger, type PageToContent, type ReplyMap } from "../messaging/protocol.js";

type ContentRequest = PageToContent extends infer M ? (M extends { expectedEmail: string } ? Omit<M, "expectedEmail"> : never) : never;

export interface UploadRequest {
  bytes: Uint8Array;
  fileName: string;
  takenAtMs?: number;
  timezoneOffsetMs?: number;
}

export class PhotosGateway {
  constructor(
    readonly email: string,
    private readonly preferredTabId: number,
  ) {}

  getItem(mediaKey: string): Promise<MediaItemInfo> {
    return this.call({ type: "photos.getItem", mediaKey });
  }

  getItemDetails(mediaKey: string): Promise<ItemDetails> {
    return this.call({ type: "photos.getItemDetails", mediaKey });
  }

  readItemInfo(mediaKeys: string[]): Promise<ItemFileInfo[]> {
    return this.call({ type: "photos.readItemInfo", mediaKeys });
  }

  async setDates(changes: DateChange[]): Promise<void> {
    await this.call({ type: "photos.setDates", changes });
  }

  async downloadOriginal(mediaKey: string): Promise<Blob> {
    const r = await this.call({ type: "photos.downloadOriginal", mediaKey });
    return new Blob([Base64.decode(r.bytesBase64) as Uint8Array<ArrayBuffer>], { type: r.mimeType });
  }

  async thumbnail(baseUrl: string, maxSide: number): Promise<Blob> {
    const r = await this.call({ type: "photos.thumbnail", baseUrl, maxSide });
    return new Blob([Base64.decode(r.bytesBase64) as Uint8Array<ArrayBuffer>], { type: r.mimeType });
  }

  upload(req: UploadRequest): Promise<CreatedMediaItem> {
    return this.call({
      type: "photos.uploadPhoto",
      fileName: req.fileName,
      bytesBase64: Base64.encode(req.bytes),
      ...(req.takenAtMs !== undefined ? { takenAtMs: req.takenAtMs, timezoneOffsetMs: req.timezoneOffsetMs ?? 0 } : {}),
    });
  }

  listLibrary(page: string | null, startMs: number | null): Promise<Page<LibraryItem>> {
    return this.call({ type: "photos.listLibrary", page, startMs });
  }

  listAlbums(page: string | null): Promise<Page<AlbumRef>> {
    return this.call({ type: "photos.listAlbums", page });
  }

  listAlbumItems(albumKey: string, page: string | null): Promise<Page<LibraryItem>> {
    return this.call({ type: "photos.listAlbumItems", albumKey, page });
  }

  async addToAlbum(mediaKeys: string[], album: AlbumRef): Promise<void> {
    await this.call({ type: "photos.addToAlbum", mediaKeys, album });
  }

  async setDescription(dedupKey: string, description: string): Promise<void> {
    await this.call({ type: "photos.setDescription", dedupKey, description });
  }

  async closeModal(): Promise<void> {
    await this.call({ type: "modal.close" });
  }

  async minimizeModal(): Promise<void> {
    await this.call({ type: "modal.minimize" });
  }

  /** Short status shown on the Photos tab's chip (null clears it). */
  async reportActivity(label: string | null): Promise<void> {
    await this.call({ type: "modal.activity", label });
  }

  /** All albums of the account (follows every page). */
  async allAlbums(): Promise<AlbumRef[]> {
    const out: AlbumRef[] = [];
    let page: string | null = null;
    do {
      const r: Page<AlbumRef> = await this.listAlbums(page);
      out.push(...r.items);
      page = r.next;
    } while (page !== null);
    return out;
  }

  private async call<K extends keyof ReplyMap>(req: ContentRequest & { type: K }): Promise<ReplyMap[K]> {
    const { tabId } = await Messenger.toBackground({ type: "photos.resolveTab", email: this.email, preferredTabId: this.preferredTabId });
    return Messenger.toPhotosTab<K>(tabId, { ...req, expectedEmail: this.email } as unknown as PageToContent & { type: K });
  }
}
