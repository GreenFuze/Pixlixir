import { describe, expect, it } from "vitest";
import { ContentToBackground, Messenger, PageToContent } from "../../src/extension/messaging/protocol.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";

describe("message validation", () => {
  it("accepts well-formed messages", () => {
    const m = Messenger.parse(PageToContent, { type: "photos.getItem", expectedEmail: "a@b.com", mediaKey: "AF1QipXXXXXXXX" });
    expect(m.type).toBe("photos.getItem");
  });

  it("rejects unknown types and missing account binding", () => {
    expect(() => Messenger.parse(PageToContent, { type: "photos.deleteEverything" })).toThrow(expect.objectContaining({ code: ErrorCode.InvalidMessage }));
    expect(() => Messenger.parse(PageToContent, { type: "photos.uploadPhoto", fileName: "a.jpg", bytesBase64: "AA==" })).toThrow(PixError);
    expect(() => Messenger.parse(ContentToBackground, { type: "tab.state", account: { email: "x" }, sessionError: null, selection: { kind: "none" } })).toThrow(PixError);
  });

  it("wraps handler failures into error envelopes and unwraps them back", async () => {
    const env = await Messenger.respond(async () => { throw new PixError(ErrorCode.AccountMismatch, "wrong account", { expected: "a" }); });
    expect(env).toEqual({ ok: false, error: { code: ErrorCode.AccountMismatch, message: "wrong account", details: { expected: "a" } } });
    expect(() => Messenger.unwrap(env, "test")).toThrow("wrong account");
    expect(() => Messenger.unwrap(undefined, "test")).toThrow(expect.objectContaining({ code: ErrorCode.NoHandler }));
  });
});
