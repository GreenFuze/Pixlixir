/**
 * Live adapter over the authenticated photos.google.com web session.
 * Runs ONLY inside the Photos tab's content script (where the session tokens live).
 */

import type { AccountRef, Capability, CreatedMediaItem, MediaItemInfo } from "../domain/types.js";
import { itemWebUrl, RenditionUrl, type PhotosLibraryAdapter, type UploadOptions } from "./adapter.js";
import { ErrorCode, PixError } from "../shared/errors.js";
import { LIVE_CAPABILITIES } from "./capabilities.js";
import { BatchExecuteClient, type FetchLike } from "./protocol/batchexecute.js";
import { PhotosRpc } from "./protocol/rpcs.js";
import type { SessionContext } from "./protocol/session.js";
import { ResumableUploader } from "./protocol/uploader.js";

export class LiveWebAdapter implements PhotosLibraryAdapter {
  readonly account: AccountRef;
  readonly #rpc: PhotosRpc;
  readonly #uploader: ResumableUploader;
  readonly #fetch: FetchLike;

  /** Refuse to move absurdly large payloads through extension messaging. */
  static readonly MAX_ORIGINAL_BYTES = 60 * 1024 * 1024;

  constructor(session: SessionContext, origin: string, sourcePath: () => string, fetchImpl: FetchLike) {
    this.account = session.account;
    this.#fetch = fetchImpl;
    this.#rpc = new PhotosRpc(new BatchExecuteClient(session, origin, sourcePath, fetchImpl));
    this.#uploader = new ResumableUploader(origin, session.account.authUserIndex, this.#rpc, fetchImpl);
  }

  async getItem(mediaKey: string): Promise<MediaItemInfo> {
    // Paragraph: core + extended info. fDcn4b only works for items in the user's own
    // library; for others it fails and the error propagates (no guessed fallback).
    const info = await this.#rpc.getItemInfo(mediaKey);
    const ext = await this.#rpc.getItemInfoExt(mediaKey);
    return {
      ref: { accountEmail: this.account.email, mediaKey: info.mediaKey },
      dedupKey: info.dedupKey,
      type: info.type,
      width: info.width,
      height: info.height,
      takenAtMs: info.takenAtMs,
      timezoneOffsetMs: info.timezoneOffsetMs,
      baseUrl: info.baseUrl,
      fileName: ext.fileName,
      sizeBytes: ext.sizeBytes,
    };
  }

  async downloadOriginal(mediaKey: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    // Paragraph: resolve the base URL, then fetch with the user's cookies.
    const info = await this.#rpc.getItemInfo(mediaKey);
    if (info.type !== "photo") throw new PixError(ErrorCode.InvalidImage, "Only photos can be downloaded as originals here.", { type: info.type });
    let res: Response;
    try {
      res = await this.#fetch(RenditionUrl.build(info.baseUrl, { kind: "original" }), { method: "GET", credentials: "include" });
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.MediaFetchFailed, "Could not download the original photo");
    }
    if (!res.ok) throw new PixError(ErrorCode.MediaFetchFailed, `Downloading the original failed (HTTP ${res.status})`, { status: res.status });

    // Paragraph: validate type and size before handing bytes on.
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) throw new PixError(ErrorCode.MediaDecodeFailed, `Expected an image but received ${blob.type || "unknown content"}`);
    if (blob.size > LiveWebAdapter.MAX_ORIGINAL_BYTES) throw new PixError(ErrorCode.MediaFetchFailed, "This photo is too large for the browser-only editor.", { size: blob.size });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type };
  }

  async uploadPhoto(bytes: Uint8Array, fileName: string, options: UploadOptions): Promise<CreatedMediaItem> {
    // Paragraph: upload + commit.
    const created = await this.#uploader.upload(bytes, fileName);

    // Paragraph: optionally align the capture time with the source item.
    if (options.takenAtMs !== undefined) {
      await this.#rpc.setTimestamps([{ dedupKey: created.dedupKey, takenAtMs: options.takenAtMs, timezoneOffsetMs: options.timezoneOffsetMs ?? 0 }]);
    }

    return {
      ref: { accountEmail: this.account.email, mediaKey: created.mediaKey },
      dedupKey: created.dedupKey,
      width: created.width,
      height: created.height,
      webUrl: itemWebUrl(this.account, created.mediaKey),
    };
  }

  capabilities(): Capability[] {
    return [...LIVE_CAPABILITIES];
  }
}
