/**
 * Content script for photos.google.com (isolated world).
 *
 * Owns the live adapter (session tokens never leave this script), observes
 * selection, renders the in-page launcher and serves typed requests from our
 * own extension pages after verifying the bound account.
 */

import type { PhotosLibraryAdapter } from "../../gphotos/adapter.js";
import { SelectionObserver, type Selection } from "../../gphotos/dom/selection.js";
import { LiveWebAdapter } from "../../gphotos/live-adapter.js";
import { WizSessionReader } from "../../gphotos/protocol/session.js";
import { Base64 } from "../../shared/codec.js";
import { ErrorCode, PixError } from "../../shared/errors.js";
import { Messenger, PageToContent, type ContentToBackground, type Envelope } from "../messaging/protocol.js";
import { Launcher } from "./launcher.js";

class ContentApp {
  #adapter: PhotosLibraryAdapter | null = null;
  #sessionError: PixError | null = null;
  #selection: Selection = { kind: "none" };
  readonly #launcher: Launcher;
  readonly #observer: SelectionObserver;

  constructor() {
    this.#launcher = new Launcher(document, {
      openPanel: () => void this.send({ type: "ui.openSidePanel" }),
      openTool: (tool, mediaKeys) => void this.send({ type: "ui.openTool", tool, mediaKeys }),
      openScan: (mediaKeys) => void this.send({ type: "ui.openScan", mediaKeys }),
    });
    this.#observer = new SelectionObserver(document, () => location.pathname, (sel) => {
      this.#selection = sel;
      this.#launcher.setSelection(sel);
      void this.publishState();
    });
  }

  start(): void {
    // Paragraph: bind to the signed-in account of this tab.
    try {
      const session = new WizSessionReader().read(document, location.pathname);
      this.#adapter = new LiveWebAdapter(session, location.origin, () => location.pathname, (input, init) => fetch(input, init));
    } catch (err) {
      this.#sessionError = PixError.wrap(err, ErrorCode.SessionUnavailable, "Could not read the Google Photos session");
      this.#launcher.setProblem(this.#sessionError.message);
    }

    // Paragraph: UI, selection tracking and request handling.
    this.#launcher.mount();
    this.#observer.start();
    chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
      if (!Messenger.isExtensionPage(sender)) return false; // only our own pages may drive this tab
      void Messenger.respond(() => this.handle(raw)).then((env: Envelope<unknown>) => sendResponse(env));
      return true;
    });
    void this.publishState();
  }

  private async handle(raw: unknown): Promise<unknown> {
    const msg = Messenger.parse(PageToContent, raw);
    const adapter = this.requireAdapter(msg.expectedEmail);
    switch (msg.type) {
      case "photos.getItem":
        return adapter.getItem(msg.mediaKey);
      case "photos.downloadOriginal": {
        const { bytes, mimeType } = await adapter.downloadOriginal(msg.mediaKey);
        return { bytesBase64: Base64.encode(bytes), mimeType };
      }
      case "photos.uploadPhoto": {
        const options: { takenAtMs?: number; timezoneOffsetMs?: number } = {};
        if (msg.takenAtMs !== undefined) options.takenAtMs = msg.takenAtMs;
        if (msg.timezoneOffsetMs !== undefined) options.timezoneOffsetMs = msg.timezoneOffsetMs;
        return adapter.uploadPhoto(Base64.decode(msg.bytesBase64), msg.fileName, options);
      }
      case "photos.listLibrary":
        return adapter.listLibrary({ page: msg.page, startMs: msg.startMs });
      case "photos.listAlbums":
        return adapter.listAlbums(msg.page);
      case "photos.listAlbumItems":
        return adapter.listAlbumItems(msg.albumKey, msg.page);
      case "photos.getItemDetails":
        return adapter.getItemDetails(msg.mediaKey);
      case "photos.thumbnail": {
        const { bytes, mimeType } = await adapter.fetchThumbnail(msg.baseUrl, msg.maxSide);
        return { bytesBase64: Base64.encode(bytes), mimeType };
      }
      case "photos.addToAlbum":
        await adapter.addToAlbum(msg.mediaKeys, msg.album);
        return null;
      case "photos.setDescription":
        await adapter.setDescription(msg.dedupKey, msg.description);
        return null;
    }
  }

  /** Account safety: refuse any operation addressed to a different account than this tab's. */
  private requireAdapter(expectedEmail: string): PhotosLibraryAdapter {
    if (!this.#adapter) throw this.#sessionError ?? new PixError(ErrorCode.SessionUnavailable, "Google Photos session not available");
    if (this.#adapter.account.email !== expectedEmail) {
      throw new PixError(ErrorCode.AccountMismatch, `This tab is signed in as ${this.#adapter.account.email}, but the operation is for ${expectedEmail}. Nothing was changed.`, {
        tabAccount: this.#adapter.account.email,
        expected: expectedEmail,
      });
    }
    return this.#adapter;
  }

  private async publishState(): Promise<void> {
    await this.send({
      type: "tab.state",
      account: this.#adapter?.account ?? null,
      sessionError: this.#sessionError?.toJSON() ?? null,
      selection: this.#selection,
    });
  }

  private async send(msg: ContentToBackground): Promise<void> {
    try {
      Messenger.unwrap(await chrome.runtime.sendMessage<ContentToBackground, Envelope<unknown>>(msg), "service worker");
    } catch (err) {
      // Extension reloaded/updated: this orphaned script can no longer talk to it.
      const e = PixError.wrap(err, ErrorCode.NoHandler, "Pixlixir could not reach its background service");
      console.error("[pixlixir]", e.toJSON());
      this.#launcher.setProblem(/context invalidated/i.test(e.message) ? "Pixlixir was updated — reload this tab." : e.message);
    }
  }
}

new ContentApp().start();
