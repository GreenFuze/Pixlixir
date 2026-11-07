import pLimit from "p-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryItem } from "../../src/domain/types.js";
import { EngineOverlapChecker } from "../../src/extension/scan/engine-overlap-checker.js";
import { ErrorCode, PixError, type SerializedError } from "../../src/shared/errors.js";

const item = (n: number): LibraryItem => ({ mediaKey: `AF1QipITEM${n}`, dedupKey: `dedup${n}`, type: "photo", width: 400, height: 300, takenAtMs: n * 1000, timezoneOffsetMs: 0, baseUrl: `https://x/${n}`, location: null });
const blob = (name: string) => new Blob([name], { type: "image/jpeg" });

/** Thumbnails by address: a list gives each download its own answer, "bad" not being decodable. */
function checker(answers: Record<string, string[]>) {
  const downloads: string[] = [];
  const loaded: number[] = [];
  const gateway = { thumbnail: async (url: string) => { downloads.push(url); const next = answers[url]?.shift(); if (next === undefined) return blob("good"); if (next === "refused") throw new PixError(ErrorCode.MediaFetchFailed, "HTTP 500"); if (next === "stop") throw new PixError(ErrorCode.AccountMismatch, "other account"); return blob(next); } };
  const worker = {
    load: async (key: number) => { loaded.push(key); return { width: 400, height: 300 }; },
    findGroups: async (keys: number[]) => ({ groups: [{ keys }] }),
    stitch: async (keys: number[]) => ({ used: keys, viewGain: 1.5, shortSide: 1, image: blob("pano"), width: 10, height: 5 }),
    remove: async () => {},
  };
  let key = 1;
  const engine = new EngineOverlapChecker(gateway as never, worker as never, pLimit(8), () => key++, async (b) => b);
  return { engine, downloads, loaded };
}

describe("EngineOverlapChecker", () => {
  const signal = new AbortController().signal;

  afterEach(() => vi.unstubAllGlobals());
  vi.stubGlobal("createImageBitmap", undefined);

  function decoder() {
    vi.stubGlobal("createImageBitmap", async (b: Blob) => {
      if ((await b.text()) === "bad") throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      return { close: () => {} };
    });
  }

  it("tries an undecodable photo once more, and needs to say nothing when that works", async () => {
    decoder();
    const { engine, downloads } = checker({ "https://x/2": ["bad", "good"] });
    const left: SerializedError[] = [];
    const groups = await engine.check([item(1), item(2)], signal, () => {}, (e) => left.push(e));
    expect(left).toEqual([]);
    expect(groups[0]!.mediaKeys).toHaveLength(2);
    expect(downloads.filter((u) => u === "https://x/2")).toHaveLength(2);
  });

  it("checks the others without a photo it still cannot decode, and says which", async () => {
    decoder();
    const { engine } = checker({ "https://x/3": ["bad", "bad"] });
    const left: SerializedError[] = [];
    const groups = await engine.check([item(1), item(2), item(3)], signal, () => {}, (e) => left.push(e));
    expect(groups[0]!.mediaKeys).toEqual([item(1).mediaKey, item(2).mediaKey]);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ code: ErrorCode.MediaDecodeFailed, details: { mediaKey: item(3).mediaKey } });
  });

  it("fails the sequence when fewer than two photos are left", async () => {
    decoder();
    const { engine } = checker({ "https://x/2": ["bad", "bad"] });
    await expect(engine.check([item(1), item(2)], signal, () => {})).rejects.toMatchObject({ code: ErrorCode.MediaDecodeFailed, details: { mediaKey: item(2).mediaKey } });
  });

  it("stops at once on a problem that would hit everything, and does not retry a failed download", async () => {
    decoder();
    const stopped = checker({ "https://x/2": ["stop"] });
    await expect(stopped.engine.check([item(1), item(2), item(3)], signal, () => {})).rejects.toMatchObject({ code: ErrorCode.AccountMismatch });
    const refused = checker({ "https://x/2": ["refused"] });
    const left: SerializedError[] = [];
    await refused.engine.check([item(1), item(2), item(3)], signal, () => {}, (e) => left.push(e));
    expect(left[0]!.message).toBe("HTTP 500");
    expect(refused.downloads.filter((u) => u === "https://x/2")).toHaveLength(1);
  });
});
