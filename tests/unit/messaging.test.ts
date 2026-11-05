import { describe, expect, it } from "vitest";
import { ContentToBackground, Messenger, PageToContent } from "../../src/extension/messaging/protocol.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";

describe("sender checks", () => {
  const ID = "abcdefghijklmnop";
  const withRuntime = (fn: () => void) => {
    (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { id: ID } };
    try {
      fn();
    } finally {
      delete (globalThis as unknown as { chrome?: unknown }).chrome;
    }
  };

  it("trusts our pages in a tab, in the modal iframe, and in the side panel", () => {
    withRuntime(() => {
      const page = `chrome-extension://${ID}/scan.html?tab=1`;
      expect(Messenger.isExtensionPage({ id: ID, url: page, tab: { id: 5 } } as chrome.runtime.MessageSender)).toBe(true);
      expect(Messenger.isExtensionPage({ id: ID, url: page, tab: { id: 5 }, frameId: 12 } as chrome.runtime.MessageSender)).toBe(true);
      expect(Messenger.isExtensionPage({ id: ID, url: `chrome-extension://${ID}/sidepanel.html` })).toBe(true);
    });
  });

  it("does not trust content scripts, web pages or other extensions as pages", () => {
    withRuntime(() => {
      expect(Messenger.isExtensionPage({ id: ID, url: "https://photos.google.com/", tab: { id: 5 } } as chrome.runtime.MessageSender)).toBe(false);
      expect(Messenger.isExtensionPage({ id: "other", url: `chrome-extension://other/x.html` })).toBe(false);
      expect(Messenger.isExtensionPage({ id: ID, url: "chrome-extension://other/x.html" })).toBe(false);
      expect(Messenger.isExtensionPage({ url: `chrome-extension://${ID}/scan.html` })).toBe(false);
    });
  });
});

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
