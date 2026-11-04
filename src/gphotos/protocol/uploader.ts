/**
 * Resumable media upload used by the photos.google.com web client.
 *
 * PRIVATE PROTOCOL, captured live 2026-11-04 from the web app's own
 * drag-and-drop upload:
 *   1. POST /_/upload/uploadmedia/interactive?authuser=N   (X-Goog-Upload-Command: start)
 *      -> response header x-goog-upload-url
 *   2. POST <upload-url>                                   (X-Goog-Upload-Command: upload, finalize)
 *      -> response body = upload token
 *   3. batchexecute mdpdU [[[token, fileName, clientTimeMs, 2, 2]]] -> new item
 */

import { ErrorCode, PixError } from "../../shared/errors.js";
import type { FetchLike } from "./batchexecute.js";
import type { PhotosRpc, RawCommittedUpload } from "./rpcs.js";

export class ResumableUploader {
  constructor(
    private readonly origin: string,
    private readonly authUserIndex: number,
    private readonly rpc: PhotosRpc,
    private readonly fetchImpl: FetchLike,
  ) {}

  async upload(bytes: Uint8Array, fileName: string): Promise<RawCommittedUpload> {
    // Paragraph: start a resumable session.
    const sha1 = await ResumableUploader.sha1Base64(bytes);
    const startRes = await this.send(`${this.origin}/_/upload/uploadmedia/interactive?authuser=${this.authUserIndex}`, {
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-File-Name": fileName,
      "X-Goog-Hash": `sha1=${sha1}`,
    }, ResumableUploader.encodeStartBody(bytes.byteLength), "start");
    const uploadUrl = startRes.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      throw new PixError(ErrorCode.UploadFailed, "Upload session did not return an upload URL (protocol may have changed).", { step: "start" });
    }

    // Paragraph: send the bytes and finalize; the body is the upload token.
    const finalRes = await this.send(new URL(uploadUrl, this.origin).toString(), {
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-File-Name": fileName,
      "X-Goog-Hash": `sha1=${sha1}`,
    }, new Blob([bytes as Uint8Array<ArrayBuffer>]), "finalize");
    const status = finalRes.headers.get("x-goog-upload-status");
    const token = (await finalRes.text()).trim();
    if (status !== "final" || token.length === 0) {
      throw new PixError(ErrorCode.UploadFailed, "Upload did not finalize.", { step: "finalize", uploadStatus: status, tokenLength: token.length });
    }

    // Paragraph: commit the token as a library item.
    return this.rpc.commitUpload(token, fileName, Date.now());
  }

  private async send(url: string, headers: Record<string, string>, body: BodyInit, step: string): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8", ...headers },
        body,
      });
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.UploadFailed, `Upload ${step} network error`, { step });
    }
    if (!res.ok) {
      throw new PixError(ErrorCode.UploadFailed, `Upload ${step} failed with HTTP ${res.status}`, { step, status: res.status });
    }
    return res;
  }

  /**
   * Start-request body exactly as the web client produces it: a small protobuf
   * (fields 1=2, 2=1, 3=1, 4=2, 7=<size varint>, 8=1) built as a JS string of
   * byte-valued chars and sent as a string (so it goes out UTF-8 encoded, as
   * the official client's does).
   */
  static encodeStartBody(size: number): string {
    const bytes = [0x08, 0x02, 0x10, 0x01, 0x18, 0x01, 0x20, 0x02, 0x38, ...ResumableUploader.varint(size), 0x40, 0x01];
    return String.fromCharCode(...bytes);
  }

  static varint(n: number): number[] {
    if (!Number.isSafeInteger(n) || n < 0) throw new PixError(ErrorCode.Internal, "varint requires a non-negative safe integer", { n });
    const out: number[] = [];
    let v = n;
    while (v >= 0x80) {
      out.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    out.push(v);
    return out;
  }

  static async sha1Base64(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>));
    let bin = "";
    for (const b of digest) bin += String.fromCharCode(b);
    return btoa(bin);
  }
}
