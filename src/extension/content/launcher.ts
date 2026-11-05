/**
 * Compact in-page entry point. Lives in a closed shadow root so Google's CSS
 * cannot affect it and the page cannot easily read its state.
 */

import type { Selection } from "../../gphotos/dom/selection.js";
import { ToolEligibility, TOOL_IDS, TOOLS, type ToolId } from "../tools.js";

export interface LauncherActions {
  openPanel(): void;
  openTool(tool: ToolId, mediaKeys: string[]): void;
  /** Opens the library scan; selected photos (if any) become its default scope. */
  openScan(mediaKeys: string[]): void;
}

const STYLE = `
  :host { all: initial; }
  .wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; font: 500 13px/1.2 system-ui, "Segoe UI", Roboto, sans-serif; }
  .menu { display: none; flex-direction: column; gap: 4px; background: #1f1b2e; color: #f4f1ff; padding: 6px; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.35); min-width: 200px; }
  .menu.open { display: flex; }
  .menu button { all: unset; cursor: pointer; padding: 9px 12px; border-radius: 8px; display: flex; justify-content: space-between; gap: 12px; }
  .menu button:hover:not([disabled]), .menu button:focus-visible { background: #3a2f63; }
  .menu button[disabled] { opacity: .45; cursor: default; }
  .hint { font-size: 11px; opacity: .7; padding: 4px 12px 6px; max-width: 220px; }
  .chip { all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 999px; color: #fff; background: linear-gradient(135deg, #7b4dff, #d24dff); box-shadow: 0 6px 20px rgba(123,77,255,.45); }
  .chip:focus-visible { outline: 3px solid #c9b6ff; outline-offset: 2px; }
  .badge { background: rgba(255,255,255,.25); border-radius: 999px; padding: 1px 7px; font-size: 11px; }
  .warn { background: #5a1e1e; }
`;

export class Launcher {
  readonly #host: HTMLElement;
  readonly #root: ShadowRoot;
  readonly #menu: HTMLDivElement;
  readonly #badge: HTMLSpanElement;
  #selection: Selection = { kind: "none" };
  #problem: string | null = null;

  constructor(private readonly doc: Document, private readonly actions: LauncherActions) {
    // Paragraph: build the shadow-DOM UI.
    this.#host = doc.createElement("pixlixir-launcher");
    this.#root = this.#host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = STYLE;
    const wrap = doc.createElement("div");
    wrap.className = "wrap";
    this.#menu = doc.createElement("div");
    this.#menu.className = "menu";
    this.#menu.setAttribute("role", "menu");
    const chip = doc.createElement("button");
    chip.className = "chip";
    chip.setAttribute("aria-label", "Pixlixir actions");
    chip.setAttribute("aria-haspopup", "menu");
    chip.textContent = "✦ Pixlixir";
    this.#badge = doc.createElement("span");
    this.#badge.className = "badge";
    chip.append(this.#badge);
    chip.addEventListener("click", () => this.toggle());
    wrap.append(this.#menu, chip);
    this.#root.append(style, wrap);

    // Paragraph: close on Escape.
    this.#root.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") this.close();
    });
  }

  mount(): void {
    if (!this.#host.isConnected) this.doc.documentElement.append(this.#host);
    this.render();
  }

  dispose(): void {
    this.#host.remove();
  }

  setSelection(selection: Selection): void {
    this.#selection = selection;
    this.render();
  }

  setProblem(problem: string | null): void {
    this.#problem = problem;
    this.render();
  }

  private toggle(): void {
    this.#menu.classList.toggle("open");
  }

  private close(): void {
    this.#menu.classList.remove("open");
  }

  private render(): void {
    // Paragraph: badge = number of selected items.
    const items = this.#selection.kind === "grid" ? this.#selection.items : this.#selection.kind === "viewer" ? [this.#selection.item] : [];
    this.#badge.textContent = items.length > 0 ? String(items.length) : "";
    this.#badge.style.display = items.length > 0 ? "" : "none";

    // Paragraph: contextual menu.
    this.#menu.replaceChildren();
    if (this.#problem) {
      const p = this.doc.createElement("div");
      p.className = "hint warn";
      p.textContent = this.#problem;
      this.#menu.append(p);
    }
    const eligible = TOOL_IDS.map((tool) => ({ tool, keys: ToolEligibility.mediaKeys(tool, items) }));
    for (const { tool, keys } of eligible) {
      this.#menu.append(this.button(TOOLS[tool].label, keys === null || this.#problem !== null, () => keys && this.actions.openTool(tool, keys)));
    }
    const photoKeys = items.filter((i) => i.type !== "video").map((i) => i.mediaKey);
    this.#menu.append(this.button(photoKeys.length > 1 ? `Scan ${photoKeys.length} selected for panoramas…` : "Scan library for panoramas…", this.#problem !== null, () => this.actions.openScan(photoKeys.length > 1 ? photoKeys : [])));
    this.#menu.append(this.button("Open Pixlixir panel", false, () => this.actions.openPanel()));
    if (eligible.every((e) => e.keys === null)) {
      for (const tool of TOOL_IDS) {
        const hint = this.doc.createElement("div");
        hint.className = "hint";
        hint.textContent = TOOLS[tool].hint;
        this.#menu.append(hint);
      }
    }
  }

  private button(label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const b = this.doc.createElement("button");
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener("click", () => {
      this.close();
      onClick();
    });
    return b;
  }
}
