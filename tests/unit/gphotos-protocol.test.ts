// @vitest-environment happy-dom
/**
 * Contract tests for the private-protocol adapter. All fixtures are synthetic:
 * shapes mirror live observations (2026-11-04) but contain no real ids or tokens.
 */

import { describe, expect, it } from "vitest";
import { itemWebUrl, RenditionUrl } from "../../src/gphotos/adapter.js";
import { LiveWebAdapter } from "../../src/gphotos/live-adapter.js";
import { BatchExecuteClient, parseBatchExecuteResponse, type FetchLike } from "../../src/gphotos/protocol/batchexecute.js";
import { PhotosRpc } from "../../src/gphotos/protocol/rpcs.js";
import { SessionContext, WizSessionReader } from "../../src/gphotos/protocol/session.js";
import { ResumableUploader } from "../../src/gphotos/protocol/uploader.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";

const KEY = "AF1QipFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00";
const DEDUP = "FAKEdedupKeyFAKEdedupKey123";

function envelope(rpcId: string, payload: unknown): string {
  const line = JSON.stringify([["wrb.fr", rpcId, JSON.stringify(payload), null, null, null, "generic"], ["di", 50]]);
  return `)]}'\n\n${line.length}\n${line}\n25\n[["e",4,null,null,100]]\n`;
}

function session(authUserIndex = 0): SessionContext {
  return new SessionContext(
    { email: "tester@example.com", gaiaId: "123", authUserIndex },
    { xsrfToken: "XSRF:secret", sessionId: "-42", buildLabel: "boq_photosuiserver_x", pathPrefix: authUserIndex ? `/u/${authUserIndex}/_/PhotosUi/` : "/_/PhotosUi/" },
  );
}

interface Captured { url: string; init: RequestInit }

function fakeFetch(responder: (url: string, init: RequestInit) => Response): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return responder(url, init); } };
}

describe("parseBatchExecuteResponse", () => {
  it("decodes the inner payload for the requested rpc", () => {
    expect(parseBatchExecuteResponse(envelope("VrseUb", [[KEY]]), "VrseUb")).toEqual([[KEY]]);
  });

  it("fails safely when the payload is null (rejected operation)", () => {
    const body = `)]}'\n\n${JSON.stringify([["wrb.fr", "mdpdU", null, null, null, [3], "generic"]])}\n`;
    expect(() => parseBatchExecuteResponse(body, "mdpdU")).toThrow(expect.objectContaining({ code: ErrorCode.RpcEnvelopeMissing }));
  });

  it("fails when the envelope is for a different rpc", () => {
    expect(() => parseBatchExecuteResponse(envelope("other", []), "VrseUb")).toThrow(/No response envelope/);
  });
});

describe("WizSessionReader", () => {
  const script = `window.WIZ_global_data = {"SNlM0e":"tok","FdrFJe":"-1","cfb2h":"bl","eptZe":"/u/1/_/PhotosUi/","oPEP7c":"a@b.com","S06Grb":"9876"};`;

  it("parses account and keeps secrets out of JSON", () => {
    const doc = new DOMParser().parseFromString(`<html><body><script>${script}</script></body></html>`, "text/html");
    const s = new WizSessionReader().read(doc, "/u/1/photo/x");
    expect(s.account).toEqual({ email: "a@b.com", gaiaId: "9876", authUserIndex: 1 });
    expect(JSON.stringify(s)).not.toContain("tok");
    expect(s.batchExecuteUrl("https://photos.google.com")).toBe("https://photos.google.com/u/1/_/PhotosUi/data/batchexecute");
  });

  it("fails fast when signed out", () => {
    const doc = new DOMParser().parseFromString(`<html><body><script>window.WIZ_global_data = {"SNlM0e":"tok"};</script></body></html>`, "text/html");
    expect(() => new WizSessionReader().read(doc, "/")).toThrow(expect.objectContaining({ code: ErrorCode.SessionUnavailable }));
  });

  it("extracts /u/N index", () => {
    expect(WizSessionReader.authUserIndexFromPath("/u/3/albums")).toBe(3);
    expect(WizSessionReader.authUserIndexFromPath("/photo/abc")).toBe(0);
  });
});

describe("BatchExecuteClient", () => {
  it("sends the web-client request format", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(envelope("VrseUb", [1])));
    await new BatchExecuteClient(session(), "https://photos.google.com", () => "/photo/x", fetch).call("VrseUb", ["k", null]);
    const { url, init } = calls[0]!;
    const u = new URL(url);
    expect(u.pathname).toBe("/_/PhotosUi/data/batchexecute");
    expect(u.searchParams.get("rpcids")).toBe("VrseUb");
    expect(u.searchParams.get("rt")).toBe("c");
    const form = new URLSearchParams(String(init.body));
    expect(JSON.parse(form.get("f.req")!)).toEqual([[["VrseUb", JSON.stringify(["k", null]), null, "generic"]]]);
    expect(form.get("at")).toBe("XSRF:secret");
    expect(init.credentials).toBe("include");
  });

  it("raises RPC_HTTP_ERROR on non-2xx", async () => {
    const { fetch } = fakeFetch(() => new Response("nope", { status: 400 }));
    await expect(new BatchExecuteClient(session(), "https://x", () => "/", fetch).call("VrseUb", [])).rejects.toMatchObject({ code: ErrorCode.RpcHttpError });
  });
});

describe("PhotosRpc", () => {
  const itemPayload = [[KEY, ["https://photos.fife.usercontent.google.com/pw/FAKE", 4000, 3000, null], 1700000000000, DEDUP, 7200000, 1700000100000, null, [], 2, { "15": 1 }]];

  it("parses VrseUb item info", async () => {
    const { fetch } = fakeFetch(() => new Response(envelope("VrseUb", itemPayload)));
    const info = await new PhotosRpc(new BatchExecuteClient(session(), "https://x", () => "/", fetch)).getItemInfo(KEY);
    expect(info).toEqual({ mediaKey: KEY, baseUrl: "https://photos.fife.usercontent.google.com/pw/FAKE", width: 4000, height: 3000, takenAtMs: 1700000000000, dedupKey: DEDUP, timezoneOffsetMs: 7200000, type: "photo" });
  });

  it("detects a protocol change instead of returning garbage", async () => {
    const changed = [[KEY, "not-an-array", 1700000000000, DEDUP]];
    const { fetch } = fakeFetch(() => new Response(envelope("VrseUb", changed)));
    await expect(new PhotosRpc(new BatchExecuteClient(session(), "https://x", () => "/", fetch)).getItemInfo(KEY)).rejects.toMatchObject({
      code: ErrorCode.RpcUnexpectedShape,
      details: expect.objectContaining({ field: "baseUrl" }),
    });
  });
});

describe("ResumableUploader / LiveWebAdapter upload", () => {
  it("encodes the start body like the web client", () => {
    const body = ResumableUploader.encodeStartBody(9539);
    expect([...body].map((c) => c.charCodeAt(0))).toEqual([0x08, 0x02, 0x10, 0x01, 0x18, 0x01, 0x20, 0x02, 0x38, 0xc3, 0x4a, 0x40, 0x01]);
  });

  it("performs start -> finalize -> mdpdU commit -> DaSgWe and returns the new item", async () => {
    const committed = [[["TOKEN", [KEY, ["https://fake", 320, 200], 1, DEDUP, 0, 2], 0]]];
    const { fetch, calls } = fakeFetch((url, init) => {
      const h = new Headers(init.headers);
      if (url.includes("/_/upload/") && h.get("X-Goog-Upload-Command") === "start") {
        return new Response("", { headers: { "x-goog-upload-url": "/_/upload/uploadmedia/interactive?authuser=2&upload_id=FAKE&upload_protocol=resumable", "x-goog-upload-status": "active" } });
      }
      if (url.includes("upload_id=FAKE")) return new Response("TOKEN", { headers: { "x-goog-upload-status": "final" } });
      if (url.includes("rpcids=mdpdU")) return new Response(envelope("mdpdU", committed));
      if (url.includes("rpcids=DaSgWe")) return new Response(envelope("DaSgWe", []));
      return new Response("unexpected", { status: 500 });
    });
    const adapter = new LiveWebAdapter(session(2), "https://photos.google.com", () => "/u/2/", fetch);
    const created = await adapter.uploadPhoto(new Uint8Array([1, 2, 3]), "scan_1.jpg", { takenAtMs: 1_700_000_000_000, timezoneOffsetMs: 3_600_000 });

    expect(created.webUrl).toBe(`https://photos.google.com/u/2/photo/${KEY}`);
    expect(created.ref).toEqual({ accountEmail: "tester@example.com", mediaKey: KEY });
    expect(calls[0]!.url).toBe("https://photos.google.com/_/upload/uploadmedia/interactive?authuser=2");
    const startHeaders = new Headers(calls[0]!.init.headers);
    expect(startHeaders.get("X-Goog-Upload-Header-Content-Length")).toBe("3");
    expect(startHeaders.get("X-Goog-Hash")).toMatch(/^sha1=/);
    const commitReq = JSON.parse(new URLSearchParams(String(calls[2]!.init.body)).get("f.req")!);
    const commitPayload = JSON.parse(commitReq[0][0][1]);
    expect(commitPayload[0][0].slice(0, 2)).toEqual(["TOKEN", "scan_1.jpg"]);
    const dateReq = JSON.parse(new URLSearchParams(String(calls[3]!.init.body)).get("f.req")!);
    expect(JSON.parse(dateReq[0][0][1])).toEqual([[[DEDUP, 1_700_000_000, 3600]]]);
  });

  it("refuses to commit when finalize is not final", async () => {
    const { fetch } = fakeFetch((url, init) => {
      if (new Headers(init.headers).get("X-Goog-Upload-Command") === "start") return new Response("", { headers: { "x-goog-upload-url": "/up?upload_id=1" } });
      return new Response("", { headers: { "x-goog-upload-status": "active" } });
    });
    const adapter = new LiveWebAdapter(session(), "https://photos.google.com", () => "/", fetch);
    await expect(adapter.uploadPhoto(new Uint8Array([1]), "a.jpg", {})).rejects.toMatchObject({ code: ErrorCode.UploadFailed });
  });
});

describe("URLs", () => {
  it("builds renditions and web urls", () => {
    expect(RenditionUrl.build("https://x/pw/A", { kind: "original" })).toBe("https://x/pw/A=d");
    expect(RenditionUrl.build("https://x/pw/A", { kind: "fit", maxWidth: 800, maxHeight: 600 })).toBe("https://x/pw/A=w800-h600");
    expect(itemWebUrl({ email: "a", gaiaId: null, authUserIndex: 0 }, "K")).toBe("https://photos.google.com/photo/K");
  });

  it("PixError round-trips through serialization", () => {
    const e = new PixError(ErrorCode.AccountMismatch, "m", { a: 1 });
    expect(PixError.fromSerialized(e.toJSON())).toMatchObject({ code: ErrorCode.AccountMismatch, message: "m", details: { a: 1 } });
  });
});
