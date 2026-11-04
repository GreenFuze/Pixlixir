/**
 * Observes what the user has selected in the Google Photos UI.
 *
 * PRIVATE UI STRUCTURE (observed 2026-11-04):
 *  - Grid tiles: an `a[href*="/photo/<mediaKey>"]` whose parent also contains a
 *    `[role=checkbox]` with `aria-checked="true"` when selected. The link's
 *    aria-label starts with "Photo" or "Video".
 *  - Single-item viewer: URL path contains `/photo/<mediaKey>`.
 */

import type { MediaType } from "../../domain/types.js";

export interface SelectedItem {
  mediaKey: string;
  type: MediaType;
}

export type Selection =
  | { kind: "none" }
  | { kind: "viewer"; item: SelectedItem }
  | { kind: "grid"; items: SelectedItem[] };

const PHOTO_PATH = /\/photo\/([A-Za-z0-9_-]{20,})/;

export class SelectionObserver {
  #observer: MutationObserver | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastSignature = "";

  constructor(
    private readonly doc: Document,
    private readonly getPathname: () => string,
    private readonly onChange: (selection: Selection) => void,
  ) {}

  /** RAII-style: start() acquires observers, dispose() releases them. */
  start(): void {
    if (this.#observer) return;
    this.#observer = new MutationObserver(() => this.check());
    this.#observer.observe(this.doc.body, { subtree: true, attributes: true, attributeFilter: ["aria-checked"], childList: true });
    // The SPA changes URL via history.pushState, which isolated-world scripts cannot hook.
    this.#timer = setInterval(() => this.check(), 750);
    this.check();
  }

  dispose(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  current(): Selection {
    return SelectionObserver.read(this.doc, this.getPathname());
  }

  private check(): void {
    const sel = this.current();
    const sig = JSON.stringify(sel);
    if (sig === this.#lastSignature) return;
    this.#lastSignature = sig;
    this.onChange(sel);
  }

  static read(doc: Document, pathname: string): Selection {
    // Paragraph: grid selection wins when any checkbox is checked.
    const items: SelectedItem[] = [];
    const seen = new Set<string>();
    for (const cb of Array.from(doc.querySelectorAll('[role="checkbox"][aria-checked="true"]'))) {
      const link = SelectionObserver.tileLink(cb);
      const key = link?.getAttribute("href")?.match(PHOTO_PATH)?.[1];
      if (!link || !key || seen.has(key)) continue;
      seen.add(key);
      items.push({ mediaKey: key, type: SelectionObserver.typeFromLabel(link.getAttribute("aria-label")) });
    }
    if (items.length > 0) return { kind: "grid", items };

    // Paragraph: otherwise, a single-item viewer URL.
    const viewerKey = pathname.match(PHOTO_PATH)?.[1];
    if (viewerKey) return { kind: "viewer", item: { mediaKey: viewerKey, type: "unknown" } };

    return { kind: "none" };
  }

  private static tileLink(checkbox: Element): Element | null {
    // Walk up a few levels to the tile container holding exactly one photo link.
    // A container with several links is a date-group "select all" header, not a tile.
    let node: Element | null = checkbox.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const links = node.querySelectorAll('a[href*="/photo/"]');
      if (links.length === 1) return links[0] ?? null;
      if (links.length > 1) return null;
    }
    return null;
  }

  private static typeFromLabel(label: string | null): MediaType {
    if (!label) return "unknown";
    if (label.startsWith("Photo")) return "photo";
    if (label.startsWith("Video")) return "video";
    return "unknown";
  }
}
