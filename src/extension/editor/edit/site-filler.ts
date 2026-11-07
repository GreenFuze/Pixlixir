/**
 * Places the picture and prompt in an AI site's message box, on the user's click, and presses send
 * if the user wants that (ADR-0009). It runs once per click, in the page's isolated world. It never
 * reads the page's answers: the user brings the result back. A site that does not cooperate is
 * reported, and the user pastes by hand.
 */

import { Base64 } from "../../../shared/codec.js";
import { ErrorCode, PixError } from "../../../shared/errors.js";

export interface FillRequest {
  /** The picture as base64. */
  picture: string;
  mime: string;
  fileName: string;
  prompt: string;
  send: boolean;
}

export type FillStep = "box" | "picture" | "text" | "send";
export type FillOutcome = { ok: true; sent: boolean } | { ok: false; step: FillStep };

/** Runs inside the site's page, so it can use nothing from outside this function. */
async function fillPage(req: FillRequest): Promise<FillOutcome> {
  const COMPOSER = '[contenteditable="true"][role="textbox"], [contenteditable="true"][role="combobox"], textarea';
  const SEND = 'button[data-testid="send-button"], #composer-submit-button, button[data-testid="chat-submit"], button.send-button, button[aria-label*="send" i], button[type="submit"]';
  const ATTACHED = 'img, uploader-file-preview, [class*="attachment" i], [class*="file-preview" i], [data-testid*="attachment" i]';
  const ANCESTORS = 8;

  const wait = async <T>(find: () => T | null | undefined, ms: number): Promise<T | null> => {
    const until = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found) return found;
      if (Date.now() > until) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const shown = (e: Element) => e.getClientRects().length > 0;

  // Paragraph: the message box. A sign-in page or a check by the site has none.
  const box = await wait(() => [...document.querySelectorAll<HTMLElement>(COMPOSER)].find(shown), 15_000);
  if (!box) return { ok: false, step: "box" };
  box.focus();

  // Paragraph: where an attached picture would appear.
  let area: Element = box;
  for (let i = 0; i < ANCESTORS && area.parentElement; i++) area = area.parentElement;
  area = box.closest("form") ?? area;
  const attachedCount = () => area.querySelectorAll(ATTACHED).length;
  const before = attachedCount();

  // Paragraph: the picture: as a paste, then through the site's own file input.
  const bytes = Uint8Array.from(atob(req.picture), (c) => c.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([bytes], req.fileName, { type: req.mime }));
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  let attached = await wait(() => attachedCount() > before, 5000);
  if (!attached) {
    const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
    const input = inputs.find((i) => i.accept.includes("image")) ?? inputs[0];
    if (input) {
      input.files = data.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      attached = await wait(() => attachedCount() > before, 5000);
    }
  }
  if (!attached) return { ok: false, step: "picture" };

  // Paragraph: the prompt, the way typing would add it.
  box.focus();
  if (box instanceof HTMLTextAreaElement) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, req.prompt);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("insertText", false, req.prompt);
  }
  const typed = () => (box instanceof HTMLTextAreaElement ? box.value : (box.textContent ?? "")).trim();
  if (!typed().startsWith(req.prompt.slice(0, 20))) return { ok: false, step: "text" };
  if (!req.send) return { ok: true, sent: false };

  // Paragraph: send, once the site has finished taking the picture. A cleared box means it went.
  const ready = (b: HTMLButtonElement) => shown(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true";
  const send = await wait(() => [...area.querySelectorAll<HTMLButtonElement>(SEND)].find(ready) ?? [...document.querySelectorAll<HTMLButtonElement>(SEND)].find(ready), 60_000);
  if (!send) return { ok: false, step: "send" };
  send.click();
  const cleared = await wait(() => typed() === "", 8000);
  return cleared ? { ok: true, sent: true } : { ok: false, step: "send" };
}

export class SiteFiller {
  private static readonly LOAD_TIMEOUT_MS = 30_000;

  /** Asks to work on this site. Must start from a click. */
  static request(url: string): Promise<boolean> {
    return chrome.permissions.request({ permissions: ["scripting"], origins: [`${new URL(url).origin}/*`] });
  }

  /** Waits for the tab to load, then fills it once. */
  static async fill(tabId: number, picture: Blob, prompt: string, send: boolean): Promise<FillOutcome> {
    await SiteFiller.loaded(tabId);
    const request: FillRequest = { picture: Base64.encode(new Uint8Array(await picture.arrayBuffer())), mime: picture.type, fileName: "photo.png", prompt, send };
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: fillPage, args: [request] });
    if (!frame?.result) throw new PixError(ErrorCode.SiteFillFailed, "The site's page gave no answer", { tabId });
    return frame.result;
  }

  private static async loaded(tabId: number): Promise<void> {
    const until = Date.now() + SiteFiller.LOAD_TIMEOUT_MS;
    while ((await chrome.tabs.get(tabId)).status !== "complete") {
      if (Date.now() > until) throw new PixError(ErrorCode.SiteFillFailed, "The site took too long to open", { tabId });
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
