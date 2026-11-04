/**
 * Typed wrappers over individual Google Photos private RPCs.
 *
 * PRIVATE PROTOCOL. RPC ids and positional indices are documented, with the
 * date and method of verification, in docs/feasibility/google-photos-protocol.md.
 * Nothing outside src/gphotos may reference RPC ids or indices.
 */

import type { MediaType } from "../../domain/types.js";
import type { BatchExecuteClient } from "./batchexecute.js";
import { PositionalReader } from "./positional.js";

export const RpcId = {
  getItemInfo: "VrseUb",
  getItemInfoExt: "fDcn4b",
  commitUpload: "mdpdU",
  setTimestamps: "DaSgWe",
} as const;

/** Ext-object key that marks video items (GPTK, observed in lcxiM/VrseUb). */
const VIDEO_EXT_KEY = "76647426";

export interface RawItemInfo {
  mediaKey: string;
  dedupKey: string;
  baseUrl: string;
  width: number;
  height: number;
  takenAtMs: number;
  timezoneOffsetMs: number;
  type: MediaType;
}

export interface RawItemExtInfo {
  fileName: string | null;
  sizeBytes: number | null;
}

export interface RawCommittedUpload {
  mediaKey: string;
  dedupKey: string;
  width: number;
  height: number;
}

export class PhotosRpc {
  constructor(private readonly client: BatchExecuteClient) {}

  /** VrseUb — core item info. Live-verified 2026-11-04 (read-only). */
  async getItemInfo(mediaKey: string): Promise<RawItemInfo> {
    const data = await this.client.call(RpcId.getItemInfo, [mediaKey, null, null, null, null]);
    const r = new PositionalReader(RpcId.getItemInfo, data);
    const item = r.array([0], "item");
    const isVideo = item.some((x) => typeof x === "object" && x !== null && !Array.isArray(x) && VIDEO_EXT_KEY in x);
    return {
      mediaKey: r.string([0, 0], "mediaKey"),
      baseUrl: r.string([0, 1, 0], "baseUrl"),
      width: r.number([0, 1, 1], "width"),
      height: r.number([0, 1, 2], "height"),
      takenAtMs: r.number([0, 2], "takenAt"),
      dedupKey: r.string([0, 3], "dedupKey"),
      timezoneOffsetMs: r.optionalNumber([0, 4]) ?? 0,
      type: isVideo ? "video" : "photo",
    };
  }

  /** fDcn4b — extended info (file name, size). Own-library items only. Live-verified 2026-11-04. */
  async getItemInfoExt(mediaKey: string): Promise<RawItemExtInfo> {
    const data = await this.client.call(RpcId.getItemInfoExt, [mediaKey, 1, null, null, 1]);
    const r = new PositionalReader(RpcId.getItemInfoExt, data);
    return { fileName: r.optionalString([0, 2]), sizeBytes: r.optionalNumber([0, 5]) };
  }

  /** mdpdU — commit an uploaded blob as a new library item. Format captured live 2026-11-04. */
  async commitUpload(uploadToken: string, fileName: string, clientTimeMs: number): Promise<RawCommittedUpload> {
    const data = await this.client.call(RpcId.commitUpload, [[[uploadToken, fileName, clientTimeMs, 2, 2]]]);
    const r = new PositionalReader(RpcId.commitUpload, data);
    return {
      mediaKey: r.string([0, 0, 1, 0], "mediaKey"),
      width: r.number([0, 0, 1, 1, 1], "width"),
      height: r.number([0, 0, 1, 1, 2], "height"),
      dedupKey: r.string([0, 0, 1, 3], "dedupKey"),
    };
  }

  /** DaSgWe — set capture time (seconds) and timezone offset (seconds) on owned items. */
  async setTimestamps(items: readonly { dedupKey: string; takenAtMs: number; timezoneOffsetMs: number }[]): Promise<void> {
    const payload = [items.map((i) => [i.dedupKey, Math.round(i.takenAtMs / 1000), Math.round(i.timezoneOffsetMs / 1000)])];
    await this.client.call(RpcId.setTimestamps, payload);
  }
}
