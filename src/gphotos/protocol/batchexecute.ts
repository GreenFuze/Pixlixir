/**
 * batchexecute transport for the Google Photos web app.
 *
 * PRIVATE PROTOCOL. Request format observed live on 2026-11-04 and consistent
 * with xob0t/Google-Photos-Toolkit (MIT). One RPC per request.
 */

import { ErrorCode, PixError } from "../../shared/errors.js";
import type { SessionContext } from "./session.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class BatchExecuteClient {
  #reqId = Math.floor(100000 + Math.random() * 800000);

  constructor(
    private readonly session: SessionContext,
    private readonly origin: string,
    private readonly sourcePath: () => string,
    private readonly fetchImpl: FetchLike,
  ) {}

  /** Execute one RPC and return its decoded JSON payload. */
  async call(rpcId: string, payload: unknown): Promise<unknown> {
    // Paragraph: build the request exactly like the web client.
    this.#reqId += 100000;
    const params = this.session.batchExecuteParams(rpcId, this.sourcePath(), this.#reqId);
    const url = `${this.session.batchExecuteUrl(this.origin)}?${params.toString()}`;
    const fReq = JSON.stringify([[[rpcId, JSON.stringify(payload), null, "generic"]]]);
    const body = `f.req=${encodeURIComponent(fReq)}&${this.session.xsrfFormField()}&`;

    // Paragraph: send and check transport status.
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
      });
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.RpcHttpError, `Network error calling ${rpcId}`, { rpcId });
    }
    if (!res.ok) {
      throw new PixError(ErrorCode.RpcHttpError, `Google Photos RPC ${rpcId} failed with HTTP ${res.status}`, { rpcId, status: res.status });
    }

    // Paragraph: decode the envelope.
    return parseBatchExecuteResponse(await res.text(), rpcId);
  }
}

/**
 * Parse an `rt=c` batchexecute response body:
 *   )]}'\n\n<len>\n[["wrb.fr","<rpcId>","<json>",...]]\n<len>\n[["e",...]]
 * Returns the decoded inner JSON for `rpcId`. Fails safely on anything unexpected.
 */
export function parseBatchExecuteResponse(text: string, rpcId: string): unknown {
  for (const line of text.split("\n")) {
    if (!line.includes("wrb.fr")) continue;

    // Paragraph: each envelope line is a JSON array of entries.
    let entries: unknown;
    try {
      entries = JSON.parse(line);
    } catch {
      continue; // a chunk-length line or partial chunk; envelopes are always whole lines
    }
    if (!Array.isArray(entries)) continue;

    // Paragraph: find our RPC's entry and decode its payload string.
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry[0] !== "wrb.fr" || entry[1] !== rpcId) continue;
      const inner = entry[2];
      if (typeof inner !== "string") {
        const code = entry[5] === undefined || entry[5] === null ? "" : ` Google's code: ${JSON.stringify(entry[5])}.`;
        throw new PixError(ErrorCode.RpcEnvelopeMissing, `Google Photos returned no data for ${rpcId} (the operation was rejected or its format changed).${code}`, {
          rpcId,
          errorPart: entry[5] ?? null,
        });
      }
      try {
        return JSON.parse(inner);
      } catch (err) {
        throw PixError.wrap(err, ErrorCode.RpcUnexpectedShape, `Unparseable payload for ${rpcId}`, { rpcId });
      }
    }
  }
  throw new PixError(ErrorCode.RpcEnvelopeMissing, `No response envelope for ${rpcId}`, { rpcId, bodyLength: text.length });
}
