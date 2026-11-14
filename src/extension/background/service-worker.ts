/**
 * Service worker: routes messages, tracks Google Photos tabs and their bound
 * accounts, and opens the side panel / editor. Holds no critical state in
 * memory — the tab registry lives in chrome.storage.session so it survives
 * service-worker restarts.
 */

import type { AccountRef, LibraryItem, Page } from "../../domain/types.js";
import { Base64 } from "../../shared/codec.js";
import { ErrorCode, PixError } from "../../shared/errors.js";
import { LocalApiService, type AccountDirectory, type ApiLibrary } from "../api/api-service.js";
import { ApiConfigStore, NativeApiBridge } from "../api/native-bridge.js";
import { ContentToBackground, Messenger, PageToBackground, type PageToContent, type PanelState, type ReplyMap, type TabState } from "../messaging/protocol.js";
import { SCAN_PAGE, SCAN_SELECTION_PREFIX, SETTINGS_PAGE, TOOLS, type ScanHandover, type ToolId } from "../tools.js";

class TabRegistry {
  static readonly KEY = "pixlixir.tabs";

  async all(): Promise<Record<string, TabState>> {
    const got = await chrome.storage.session.get(TabRegistry.KEY);
    return (got[TabRegistry.KEY] as Record<string, TabState> | undefined) ?? {};
  }

  async get(tabId: number): Promise<TabState | null> {
    return (await this.all())[String(tabId)] ?? null;
  }

  async put(state: TabState): Promise<void> {
    const all = await this.all();
    all[String(state.tabId)] = state;
    await chrome.storage.session.set({ [TabRegistry.KEY]: all });
  }

  async remove(tabId: number): Promise<void> {
    const all = await this.all();
    delete all[String(tabId)];
    await chrome.storage.session.set({ [TabRegistry.KEY]: all });
  }

  /** A live Photos tab signed in as `email`, preferring the given one. Never substitutes another account. */
  async liveTabFor(email: string, preferredTabId: number | null): Promise<number> {
    const candidates = Object.values(await this.all()).filter((t) => t.account?.email === email);
    const preferred = candidates.find((t) => t.tabId === preferredTabId);
    for (const t of preferred ? [preferred, ...candidates] : candidates) {
      try {
        await chrome.tabs.get(t.tabId);
        return t.tabId;
      } catch {
        await this.remove(t.tabId); // stale entry for a closed tab
      }
    }
    throw new PixError(ErrorCode.TabNotBound, `No open Google Photos tab is signed in as ${email}. Open photos.google.com with that account and retry.`, { email });
  }

  /** Accounts with a live, signed-in Photos tab, each once. */
  async liveAccounts(): Promise<AccountRef[]> {
    const out = new Map<string, AccountRef>();
    for (const t of Object.values(await this.all())) {
      if (!t.account || out.has(t.account.email)) continue;
      try {
        await chrome.tabs.get(t.tabId);
        out.set(t.account.email, t.account);
      } catch {
        await this.remove(t.tabId);
      }
    }
    return [...out.values()];
  }
}

/** One account's library for the Local API, through its Photos tab (the sign-in stays there, ADR-0001). */
class TabLibrary implements ApiLibrary {
  constructor(private readonly tabs: TabRegistry, private readonly email: string) {}

  getItem(mediaKey: string) { return this.call({ type: "photos.getItem", mediaKey }); }
  getItemDetails(mediaKey: string) { return this.call({ type: "photos.getItemDetails", mediaKey }); }
  readItemInfo(mediaKeys: string[]) { return this.call({ type: "photos.readItemInfo", mediaKeys }); }
  search(query: string, page: string | null): Promise<Page<LibraryItem>> { return this.call({ type: "photos.search", query, page }); }
  listLibrary(page: string | null, startMs: number | null) { return this.call({ type: "photos.listLibrary", page, startMs }); }
  listAlbums(page: string | null) { return this.call({ type: "photos.listAlbums", page }); }
  listAlbumItems(albumKey: string, page: string | null) { return this.call({ type: "photos.listAlbumItems", albumKey, page }); }

  async downloadOriginal(mediaKey: string) {
    const r = await this.call({ type: "photos.downloadOriginal", mediaKey });
    return { bytes: Base64.decode(r.bytesBase64), mimeType: r.mimeType };
  }

  async thumbnail(baseUrl: string, maxSide: number) {
    const r = await this.call({ type: "photos.thumbnail", baseUrl, maxSide });
    return { bytes: Base64.decode(r.bytesBase64), mimeType: r.mimeType };
  }

  private async call<K extends keyof ReplyMap>(req: { type: K } & Record<string, unknown>): Promise<ReplyMap[K]> {
    const tabId = await this.tabs.liveTabFor(this.email, null);
    return Messenger.toPhotosTab<K>(tabId, { ...req, expectedEmail: this.email } as unknown as PageToContent & { type: K });
  }
}

class BackgroundRouter {
  constructor(private readonly tabs: TabRegistry, private readonly api: NativeApiBridge) {}

  register(): void {
    chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
      void Messenger.respond(() => this.route(raw, sender)).then(sendResponse);
      return true; // async response
    });
    chrome.tabs.onRemoved.addListener((tabId) => void this.tabs.remove(tabId));
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => console.error("[pixlixir] setPanelBehavior failed", err));

    // Paragraph: the Local API comes back on with Chrome, and whenever this worker wakes, if it is switched on.
    chrome.runtime.onStartup.addListener(() => void this.api.ensure());
    void this.api.ensure();
  }

  private async route(raw: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    // Paragraph: content scripts on photos.google.com.
    if (Messenger.isPhotosContentScript(sender)) {
      const msg = Messenger.parse(ContentToBackground, raw);
      const tabId = sender.tab!.id!;
      switch (msg.type) {
        case "tab.state":
          await this.tabs.put({ tabId, account: msg.account, sessionError: msg.sessionError, selection: msg.selection, activity: msg.activity, updatedAt: Date.now() });
          return null;
        case "ui.openTool":
          return this.openTool(msg.tool, tabId, msg.mediaKeys);
        case "ui.openSidePanel":
          await chrome.sidePanel.open({ tabId });
          return null;
        case "ui.openScan":
          return this.openScan(tabId, msg.plan);
      }
    }

    // Paragraph: our own extension pages (side panel, editor).
    if (Messenger.isExtensionPage(sender)) {
      const msg = Messenger.parse(PageToBackground, raw);
      switch (msg.type) {
        case "panel.getState":
          return this.panelState(msg.windowId);
        case "panel.openTool":
          return this.openTool(msg.tool, msg.tabId, msg.mediaKeys);
        case "photos.resolveTab":
          return this.resolveTab(msg.email, msg.preferredTabId);
        case "panel.openScan":
          return this.openScan(msg.tabId, msg.plan);
        case "panel.openSettings":
          await this.openPage(SETTINGS_PAGE, msg.tabId, { email: await this.boundEmail(msg.tabId) });
          return null;
        case "panel.accounts":
          return { emails: [...new Set(Object.values(await this.tabs.all()).flatMap((t) => (t.account ? [t.account.email] : [])))] };
        case "api.getState":
          return this.api.state();
        case "api.setEnabled":
          return this.api.setEnabled(msg.enabled);
        case "api.setPort":
          return this.api.setPort(msg.port);
        case "api.newKey":
          return this.api.newKey();
      }
    }

    throw new PixError(ErrorCode.UntrustedSender, "Message from an untrusted sender was rejected", { senderUrl: sender.url ?? null });
  }

  private async panelState(windowId: number): Promise<PanelState> {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    const isPhotos = typeof active?.url === "string" && active.url.startsWith(`${Messenger.PHOTOS_ORIGIN}/`);
    const albumKey = isPhotos ? (/\/album\/([A-Za-z0-9_-]{10,})/.exec(active?.url ?? "")?.[1] ?? null) : null;
    return { activeIsPhotos: isPhotos, activeTab: isPhotos && active?.id !== undefined ? await this.tabs.get(active.id) : null, albumKey };
  }

  /** Opens an editor tool bound to the account currently signed in on that tab. */
  private async openTool(tool: ToolId, tabId: number, mediaKeys: string[]): Promise<{ editorTabId: number }> {
    const spec = TOOLS[tool];
    if (mediaKeys.length < spec.minPhotos || mediaKeys.length > spec.maxPhotos) {
      throw new PixError(ErrorCode.InvalidMessage, spec.hint, { tool, photos: mediaKeys.length });
    }
    const email = await this.boundEmail(tabId);
    return { editorTabId: await this.openPage(spec.page, tabId, { tab: String(tabId), email, media: mediaKeys.join(",") }) };
  }

  /**
   * Starts a scan in a modal over that Photos tab, bound to its account. The plan (possibly
   * thousands of keys) is parked in session storage under a one-time id, which the scan page
   * requires: scan.html is reachable from photos.google.com, so a frame not opened through
   * here refuses to start. Work already running is brought back instead of replaced.
   */
  private async openScan(tabId: number, plan: ScanHandover["plan"]): Promise<null> {
    const email = await this.boundEmail(tabId);
    const key = SCAN_SELECTION_PREFIX + crypto.randomUUID();
    await chrome.storage.session.set({ [key]: { accountEmail: email, plan } satisfies ScanHandover });
    const url = chrome.runtime.getURL(`${SCAN_PAGE}?${new URLSearchParams({ tab: String(tabId), email, sel: key.slice(SCAN_SELECTION_PREFIX.length) }).toString()}`);
    const { started } = await Messenger.toPhotosTab(tabId, { type: "modal.open", expectedEmail: email, url });
    if (!started) await chrome.storage.session.remove(key);
    return null;
  }

  private async boundEmail(tabId: number): Promise<string> {
    const state = await this.tabs.get(tabId);
    if (!state?.account) {
      throw new PixError(ErrorCode.TabNotBound, "This Google Photos tab has no detected account yet. Reload the tab and try again.", { tabId });
    }
    return state.account.email;
  }

  private async openPage(page: string, nextToTabId: number, params: Record<string, string>): Promise<number> {
    const url = chrome.runtime.getURL(`${page}?${new URLSearchParams(params).toString()}`);
    const created = await chrome.tabs.create({ url, index: ((await chrome.tabs.get(nextToTabId)).index ?? 0) + 1 });
    if (created.id === undefined) throw new PixError(ErrorCode.Internal, "Extension tab was not created", { page });
    return created.id;
  }

  /** Finds a live Photos tab signed in as `email`, preferring the original one. Never substitutes another account. */
  private async resolveTab(email: string, preferredTabId: number | null): Promise<{ tabId: number }> {
    return { tabId: await this.tabs.liveTabFor(email, preferredTabId) };
  }
}

// Paragraph: the tab registry, the Local API behind it, and the router.
const tabs = new TabRegistry();
const directory: AccountDirectory = { accounts: () => tabs.liveAccounts(), library: (account) => new TabLibrary(tabs, account.email) };
const version = chrome.runtime.getManifest().version;
const holder: { bridge: NativeApiBridge | null } = { bridge: null };
const service = new LocalApiService(directory, { pixlixir: version, helper: () => holder.bridge?.helperVersion ?? null });
holder.bridge = new NativeApiBridge(new ApiConfigStore(), service, version);
new BackgroundRouter(tabs, holder.bridge).register();
