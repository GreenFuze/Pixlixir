/**
 * Service worker: routes messages, tracks Google Photos tabs and their bound
 * accounts, and opens the side panel / editor. Holds no critical state in
 * memory — the tab registry lives in chrome.storage.session so it survives
 * service-worker restarts.
 */

import { ErrorCode, PixError } from "../../shared/errors.js";
import { ContentToBackground, Messenger, PageToBackground, type PanelState, type TabState } from "../messaging/protocol.js";
import { SCAN_PAGE, SCAN_SELECTION_PREFIX, TOOLS, type ToolId } from "../tools.js";

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
}

class BackgroundRouter {
  constructor(private readonly tabs: TabRegistry) {}

  register(): void {
    chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
      void Messenger.respond(() => this.route(raw, sender)).then(sendResponse);
      return true; // async response
    });
    chrome.tabs.onRemoved.addListener((tabId) => void this.tabs.remove(tabId));
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err: unknown) => console.error("[pixlixir] setPanelBehavior failed", err));
  }

  private async route(raw: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    // Paragraph: content scripts on photos.google.com.
    if (Messenger.isPhotosContentScript(sender)) {
      const msg = Messenger.parse(ContentToBackground, raw);
      const tabId = sender.tab!.id!;
      switch (msg.type) {
        case "tab.state":
          await this.tabs.put({ tabId, account: msg.account, sessionError: msg.sessionError, selection: msg.selection, updatedAt: Date.now() });
          return null;
        case "ui.openTool":
          return this.openTool(msg.tool, tabId, msg.mediaKeys);
        case "ui.openSidePanel":
          await chrome.sidePanel.open({ tabId });
          return null;
        case "ui.openScan":
          return this.openScan(tabId, msg.mediaKeys);
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
          return this.openScan(msg.tabId, msg.mediaKeys);
      }
    }

    throw new PixError(ErrorCode.UntrustedSender, "Message from an untrusted sender was rejected", { senderUrl: sender.url ?? null });
  }

  private async panelState(windowId: number): Promise<PanelState> {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    const isPhotos = typeof active?.url === "string" && active.url.startsWith(`${Messenger.PHOTOS_ORIGIN}/`);
    return { activeIsPhotos: isPhotos, activeTab: isPhotos && active?.id !== undefined ? await this.tabs.get(active.id) : null };
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
   * Opens the library scan bound to the tab's account. A selection is parked in session
   * storage (it can be thousands of keys); an album open in the tab preselects that album.
   */
  private async openScan(tabId: number, mediaKeys: string[]): Promise<{ scanTabId: number }> {
    const email = await this.boundEmail(tabId);
    const params: Record<string, string> = { tab: String(tabId), email };
    if (mediaKeys.length > 0) {
      const id = crypto.randomUUID();
      await chrome.storage.session.set({ [SCAN_SELECTION_PREFIX + id]: mediaKeys });
      params.sel = id;
    }
    const album = /\/album\/([A-Za-z0-9_-]{10,})/.exec((await chrome.tabs.get(tabId)).url ?? "")?.[1];
    if (album) params.album = album;
    return { scanTabId: await this.openPage(SCAN_PAGE, tabId, params) };
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
    const all = await this.tabs.all();
    const candidates = Object.values(all).filter((t) => t.account?.email === email);
    const preferred = candidates.find((t) => t.tabId === preferredTabId);
    for (const t of preferred ? [preferred, ...candidates] : candidates) {
      try {
        await chrome.tabs.get(t.tabId);
        return { tabId: t.tabId };
      } catch {
        await this.tabs.remove(t.tabId); // stale entry for a closed tab
      }
    }
    throw new PixError(ErrorCode.TabNotBound, `No open Google Photos tab is signed in as ${email}. Open photos.google.com with that account and retry.`, { email });
  }
}

new BackgroundRouter(new TabRegistry()).register();
