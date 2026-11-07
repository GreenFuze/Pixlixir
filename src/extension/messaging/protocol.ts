/**
 * Typed, validated extension messaging.
 *
 * Every message is parsed with zod at the receiving end and every sender is
 * checked (see Messenger.assert* helpers). Replies use a uniform envelope so
 * errors keep their code and context across boundaries.
 */

import { z } from "zod";
import type { AlbumRef, CreatedMediaItem, ItemDetails, ItemFileInfo, LibraryItem, MediaItemInfo, Page } from "../../domain/types.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { MAX_SCAN_SELECTION, TOOL_IDS, TOOLS, type ToolId } from "../tools.js";

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

const ToolSchema = z.enum(TOOL_IDS as [ToolId, ...ToolId[]]);
const MediaKeysSchema = z.array(z.string().min(10)).min(1).max(Math.max(...TOOL_IDS.map((t) => TOOLS[t].maxPhotos)));
const AlbumRefSchema = z.object({ mediaKey: z.string().min(10), title: z.string(), shared: z.boolean() });
/** What a scan should do. Its selection may be larger than any editor accepts. */
const ScanPlanSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("dateRange"), fromMs: z.number(), toMs: z.number() }),
    z.object({ kind: z.literal("album"), album: AlbumRefSchema }),
    z.object({ kind: z.literal("selection"), mediaKeys: z.array(z.string().min(10)).max(MAX_SCAN_SELECTION) }),
    z.object({ kind: z.literal("library") }),
  ]),
  detectors: z.object({ panorama: z.boolean(), dates: z.boolean(), duplicates: z.boolean() }),
  recheck: z.boolean(),
});
const ActivitySchema = z.object({ label: z.string().max(40), busy: z.boolean() });
const PageTokenSchema = z.string().min(1).max(4000).nullable();

const SerializedErrorSchema = z.object({ code: z.enum(Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]]), message: z.string(), details: z.record(z.string(), z.unknown()).optional() });

// ---- content script -> service worker --------------------------------------

export const ContentToBackground = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tab.state"), account: AccountSchema.nullable(), sessionError: SerializedErrorSchema.nullable(), selection: SelectionSchema, activity: ActivitySchema.nullable() }),
  z.object({ type: z.literal("ui.openTool"), tool: ToolSchema, mediaKeys: MediaKeysSchema }),
  z.object({ type: z.literal("ui.openSidePanel") }),
  z.object({ type: z.literal("ui.openScan"), plan: ScanPlanSchema }),
]);
export type ContentToBackground = z.infer<typeof ContentToBackground>;

// ---- extension pages -> service worker -------------------------------------

export const PageToBackground = z.discriminatedUnion("type", [
  z.object({ type: z.literal("panel.getState"), windowId: z.number().int() }),
  z.object({ type: z.literal("panel.openTool"), tool: ToolSchema, tabId: z.number().int(), mediaKeys: MediaKeysSchema }),
  z.object({ type: z.literal("photos.resolveTab"), email: z.string(), preferredTabId: z.number().int().nullable() }),
  z.object({ type: z.literal("panel.openScan"), tabId: z.number().int(), plan: ScanPlanSchema }),
  z.object({ type: z.literal("panel.openSettings"), tabId: z.number().int() }),
  z.object({ type: z.literal("panel.accounts") }),
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
  z.object({ type: z.literal("photos.listLibrary"), expectedEmail: z.string(), page: PageTokenSchema, startMs: z.number().nullable() }),
  z.object({ type: z.literal("photos.listAlbums"), expectedEmail: z.string(), page: PageTokenSchema }),
  z.object({ type: z.literal("photos.listAlbumItems"), expectedEmail: z.string(), albumKey: z.string().min(10), page: PageTokenSchema }),
  z.object({ type: z.literal("photos.getItemDetails"), expectedEmail: z.string(), mediaKey: z.string().min(10) }),
  z.object({ type: z.literal("photos.readItemInfo"), expectedEmail: z.string(), mediaKeys: z.array(z.string().min(10)).min(1).max(500) }),
  z.object({
    type: z.literal("photos.setDates"),
    expectedEmail: z.string(),
    changes: z.array(z.object({ dedupKey: z.string().min(10), takenAtMs: z.number(), timezoneOffsetMs: z.number() })).min(1).max(500),
  }),
  z.object({ type: z.literal("photos.moveToTrash"), expectedEmail: z.string(), dedupKeys: z.array(z.string().min(10)).min(1).max(100) }),
  z.object({ type: z.literal("photos.listTrash"), expectedEmail: z.string(), page: PageTokenSchema }),
  z.object({ type: z.literal("photos.thumbnail"), expectedEmail: z.string(), baseUrl: z.string().url().max(2000), maxSide: z.number().int().min(64).max(2048) }),
  z.object({ type: z.literal("photos.fileHead"), expectedEmail: z.string(), baseUrl: z.string().url().max(2000) }),
  z.object({ type: z.literal("photos.addToAlbum"), expectedEmail: z.string(), mediaKeys: z.array(z.string().min(10)).min(1).max(50), album: AlbumRefSchema }),
  z.object({ type: z.literal("photos.setDescription"), expectedEmail: z.string(), dedupKey: z.string().min(10), description: z.string().min(1).max(10000) }),
  z.object({ type: z.literal("modal.open"), expectedEmail: z.string(), url: z.string().url() }),
  z.object({ type: z.literal("modal.minimize"), expectedEmail: z.string() }),
  z.object({ type: z.literal("modal.restore"), expectedEmail: z.string() }),
  z.object({ type: z.literal("modal.close"), expectedEmail: z.string() }),
  z.object({ type: z.literal("modal.activity"), expectedEmail: z.string(), activity: ActivitySchema.nullable() }),
]);
export type PageToContent = z.infer<typeof PageToContent>;

// ---- replies -----------------------------------------------------------------

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: SerializedError };

/** Work in the scan modal of a tab. Busy work must not be replaced by a new scan. */
export type TabActivity = z.infer<typeof ActivitySchema>;

export interface TabState {
  tabId: number;
  activity: TabActivity | null;
  account: z.infer<typeof AccountSchema> | null;
  sessionError: SerializedError | null;
  selection: z.infer<typeof SelectionSchema>;
  updatedAt: number;
}

export interface PanelState {
  activeTab: TabState | null;
  /** True when the active tab is not a Google Photos tab. */
  activeIsPhotos: boolean;
  /** The album open in the active tab. */
  albumKey: string | null;
}

export interface ReplyMap {
  "panel.getState": PanelState;
  "panel.openTool": { editorTabId: number };
  "photos.resolveTab": { tabId: number };
  "photos.getItem": MediaItemInfo;
  "photos.downloadOriginal": { bytesBase64: string; mimeType: string };
  "photos.uploadPhoto": CreatedMediaItem;
  "photos.listLibrary": Page<LibraryItem>;
  "photos.listAlbums": Page<AlbumRef>;
  "photos.listAlbumItems": Page<LibraryItem>;
  "photos.getItemDetails": ItemDetails;
  "photos.readItemInfo": ItemFileInfo[];
  "photos.setDates": null;
  "photos.moveToTrash": null;
  "photos.listTrash": Page<string>;
  "photos.thumbnail": { bytesBase64: string; mimeType: string };
  "photos.fileHead": { bytesBase64: string };
  "photos.addToAlbum": null;
  "photos.setDescription": null;
  "panel.openScan": null;
  "panel.openSettings": null;
  "panel.accounts": { emails: string[] };
  /** started: false means running work was brought back instead. */
  "modal.open": { started: boolean };
  "modal.minimize": null;
  "modal.restore": null;
  "modal.close": null;
  "modal.activity": null;
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

  /**
   * Our own pages: the side panel, the service worker, and pages shown in a tab or in the
   * modal iframe (Chrome sets sender.tab for those, so it must not be part of this check;
   * the URL is what separates them from content scripts and web pages).
   */
  static isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
    return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
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
