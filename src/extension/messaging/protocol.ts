/**
 * Typed, validated extension messaging.
 *
 * Every message is parsed with zod at the receiving end and every sender is
 * checked (see Messenger.assert* helpers). Replies use a uniform envelope so
 * errors keep their code and context across boundaries.
 */

import { z } from "zod";
import type { CreatedMediaItem, MediaItemInfo } from "../../domain/types.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";

// ---- shared schemas ---------------------------------------------------------

export const AccountSchema = z.object({
  email: z.string().min(3),
  gaiaId: z.string().nullable(),
  authUserIndex: z.number().int().min(0),
});

const SelectedItemSchema = z.object({ mediaKey: z.string().min(10), type: z.enum(["photo", "video", "unknown"]) });

export const SelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("viewer"), item: SelectedItemSchema }),
  z.object({ kind: z.literal("grid"), items: z.array(SelectedItemSchema) }),
]);

const SerializedErrorSchema = z.object({ code: z.enum(Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]]), message: z.string(), details: z.record(z.string(), z.unknown()).optional() });

// ---- content script -> service worker --------------------------------------

export const ContentToBackground = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tab.state"), account: AccountSchema.nullable(), sessionError: SerializedErrorSchema.nullable(), selection: SelectionSchema }),
  z.object({ type: z.literal("ui.openSplitEditor"), mediaKey: z.string().min(10) }),
  z.object({ type: z.literal("ui.openSidePanel") }),
]);
export type ContentToBackground = z.infer<typeof ContentToBackground>;

// ---- extension pages -> service worker -------------------------------------

export const PageToBackground = z.discriminatedUnion("type", [
  z.object({ type: z.literal("panel.getState"), windowId: z.number().int() }),
  z.object({ type: z.literal("panel.openSplitEditor"), tabId: z.number().int(), mediaKey: z.string().min(10) }),
  z.object({ type: z.literal("photos.resolveTab"), email: z.string(), preferredTabId: z.number().int().nullable() }),
]);
export type PageToBackground = z.infer<typeof PageToBackground>;

// ---- extension pages -> content script (Photos tab) -------------------------

export const PageToContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("photos.getItem"), expectedEmail: z.string(), mediaKey: z.string().min(10) }),
  z.object({ type: z.literal("photos.downloadOriginal"), expectedEmail: z.string(), mediaKey: z.string().min(10) }),
  z.object({
    type: z.literal("photos.uploadPhoto"),
    expectedEmail: z.string(),
    fileName: z.string().min(1).max(200),
    bytesBase64: z.string().min(1),
    takenAtMs: z.number().optional(),
    timezoneOffsetMs: z.number().optional(),
  }),
]);
export type PageToContent = z.infer<typeof PageToContent>;

// ---- replies -----------------------------------------------------------------

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: SerializedError };

export interface TabState {
  tabId: number;
  account: z.infer<typeof AccountSchema> | null;
  sessionError: SerializedError | null;
  selection: z.infer<typeof SelectionSchema>;
  updatedAt: number;
}

export interface PanelState {
  activeTab: TabState | null;
  /** True when the active tab is not a Google Photos tab. */
  activeIsPhotos: boolean;
}

export interface ReplyMap {
  "panel.getState": PanelState;
  "panel.openSplitEditor": { editorTabId: number };
  "photos.resolveTab": { tabId: number };
  "photos.getItem": MediaItemInfo;
  "photos.downloadOriginal": { bytesBase64: string; mimeType: string };
  "photos.uploadPhoto": CreatedMediaItem;
}

// ---- helpers -----------------------------------------------------------------

export class Messenger {
  static readonly PHOTOS_ORIGIN = "https://photos.google.com";

  static parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const r = schema.safeParse(raw);
    if (!r.success) {
      throw new PixError(ErrorCode.InvalidMessage, "Rejected malformed extension message", { issues: r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) });
    }
    return r.data;
  }

  static isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === chrome.runtime.id && !sender.tab && typeof sender.url === "string" && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  }

  static isPhotosContentScript(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === chrome.runtime.id && sender.tab?.id !== undefined && typeof sender.url === "string" && sender.url.startsWith(`${Messenger.PHOTOS_ORIGIN}/`);
  }

  /** Runs a handler and converts its outcome into an Envelope for sendResponse. */
  static async respond<T>(work: () => Promise<T>): Promise<Envelope<T>> {
    try {
      return { ok: true, value: await work() };
    } catch (err) {
      const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Unexpected failure");
      return { ok: false, error: e.toJSON() };
    }
  }

  /** Unwraps an envelope, rethrowing remote errors as PixError. */
  static unwrap<T>(env: Envelope<T> | undefined, context: string): T {
    if (!env) throw new PixError(ErrorCode.NoHandler, `No response from ${context}`, { context });
    if (!env.ok) throw PixError.fromSerialized(env.error);
    return env.value;
  }

  static async toBackground<K extends keyof ReplyMap>(msg: PageToBackground & { type: K }): Promise<ReplyMap[K]> {
    return Messenger.unwrap(await chrome.runtime.sendMessage<PageToBackground, Envelope<ReplyMap[K]>>(msg), "service worker");
  }

  static async toPhotosTab<K extends keyof ReplyMap>(tabId: number, msg: PageToContent & { type: K }): Promise<ReplyMap[K]> {
    let env: Envelope<ReplyMap[K]> | undefined;
    try {
      env = await chrome.tabs.sendMessage<PageToContent, Envelope<ReplyMap[K]>>(tabId, msg);
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.TabNotBound, "The Google Photos tab is not reachable (closed or reloaded?)", { tabId });
    }
    return Messenger.unwrap(env, `Photos tab ${tabId}`);
  }
}
