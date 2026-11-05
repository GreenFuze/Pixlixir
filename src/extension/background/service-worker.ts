/**
 * Service worker: routes messages, tracks Google Photos tabs and their bound
 * accounts, and opens the side panel / editor. Holds no critical state in
 * memory — the tab registry lives in chrome.storage.session so it survives
 * service-worker restarts.
 */

import { ErrorCode, PixError } from "../../shared/errors.js";
import { ContentToBackground, Messenger, PageToBackground, type PanelState, type TabState } from "../messaging/protocol.js";
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
        case "panel.openSettings":
          await this.openPage(SETTINGS_PAGE, msg.tabId, { email: await this.boundEmail(msg.tabId) });
          return null;
        case "panel.accounts":
          return { emails: [...new Set(Object.values(await this.tabs.all()).flatMap((t) => (t.account ? [t.account.email] : [])))] };
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
   * Opens the library scan as a modal over that Photos tab, bound to its account. The
   * selection (possibly thousands of keys) is parked in session storage under a one-time id,
   * which the scan page requires: scan.html is reachable from photos.google.com, so a frame
   * not opened through here refuses to start. An album open in the tab preselects that album.
   */
  private async openScan(tabId: number, mediaKeys: string[]): Promise<null> {
    const email = await this.boundEmail(tabId);
    const id = crypto.randomUUID();
    await chrome.storage.session.set({ [SCAN_SELECTION_PREFIX + id]: { accountEmail: email, mediaKeys } satisfies ScanHandover });
    const params: Record<string, string> = { tab: String(tabId), email, sel: id };
    const album = /\/album\/([A-Za-z0-9_-]{10,})/.exec((await chrome.tabs.get(tabId)).url ?? "")?.[1];
    if (album) params.album = album;
    const url = chrome.runtime.getURL(`${SCAN_PAGE}?${new URLSearchParams(params).toString()}`);
    await Messenger.toPhotosTab(tabId, { type: "modal.open", expectedEmail: email, url });
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
