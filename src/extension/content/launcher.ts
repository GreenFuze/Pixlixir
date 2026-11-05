/**
 * Compact in-page entry point. Lives in a closed shadow root so Google's CSS
 * cannot affect it and the page cannot easily read its state.
 */

import type { Selection } from "../../gphotos/dom/selection.js";
import type { ScanPlan } from "../../scan/scan-plan.js";
import { FixDatesTool, ToolEligibility, TOOL_IDS, TOOLS, type ToolId } from "../tools.js";
import { ToolIcon, type ToolIconId } from "../ui/tool-icons.js";

export interface LauncherActions {
  openPanel(): void;
  openTool(tool: ToolId, mediaKeys: string[]): void;
  /** Starts a scan in the modal. */
  openScan(plan: ScanPlan): void;
  /** Brings back a minimized scan. */
  showActivity(): void;
}

const STYLE = `
  :host { all: initial; }
  .wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; font: 500 13px/1.2 system-ui, "Segoe UI", Roboto, sans-serif; }
  .menu { display: none; flex-direction: column; gap: 4px; background: #1f1b2e; color: #f4f1ff; padding: 6px; border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.35); min-width: 200px; }
  .menu.open { display: flex; }
  .menu button { all: unset; cursor: pointer; padding: 9px 12px; border-radius: 8px; display: flex; justify-content: space-between; gap: 12px; }
  .menu button:hover:not([disabled]), .menu button:focus-visible { background: #3a2f63; }
  .menu button[disabled] { opacity: .45; cursor: default; }
  .tools { display: flex; gap: 2px; }
  .menu .tools button { flex-direction: column; align-items: center; gap: 3px; padding: 7px 6px; font-size: 11px; justify-content: flex-start; }
  .tools svg { width: 84px; height: 35px; display: block; }
  .hint { font-size: 11px; opacity: .7; padding: 4px 12px 6px; max-width: 220px; }
  .activity { font-size: 12px; font-variant-numeric: tabular-nums; }
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
  readonly #activity: HTMLSpanElement;
  #activityLabel: string | null = null;
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
    this.#activity = doc.createElement("span");
    this.#activity.className = "activity";
    chip.append(this.#badge, this.#activity);
    chip.addEventListener("click", () => (this.#activityLabel ? this.actions.showActivity() : this.toggle()));
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

  /** Work running in the modal (e.g. "Scanning 34%"): shown on the chip, whose click then brings it back. */
  setActivity(label: string | null): void {
    this.#activityLabel = label;
    this.#activity.textContent = label ?? "";
    this.#activity.style.display = label ? "" : "none";
    if (label) this.close();
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
    const tools = this.doc.createElement("div");
    tools.className = "tools";
    this.#menu.append(tools);
    const eligible = TOOL_IDS.map((tool) => ({ tool, keys: ToolEligibility.mediaKeys(tool, items) }));
    for (const { tool, keys } of eligible) {
      tools.append(this.toolButton(tool, TOOLS[tool].short, keys === null ? TOOLS[tool].hint : TOOLS[tool].label, keys === null || this.#problem !== null, () => keys && this.actions.openTool(tool, keys)));
    }
    const datesPlan = FixDatesTool.plan(items);
    tools.append(this.toolButton("dates", FixDatesTool.SHORT, datesPlan ? FixDatesTool.LABEL : FixDatesTool.HINT, datesPlan === null || this.#problem !== null, () => datesPlan && this.actions.openScan(datesPlan)));
    this.#menu.append(this.button("Bulk operations", false, () => this.actions.openPanel(), "Scan by date, album or the whole library, in the side panel"));
  }

  private toolButton(icon: ToolIconId, caption: string, tooltip: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
    const b = this.button(caption, disabled, onClick, tooltip);
    b.setAttribute("aria-label", tooltip);
    b.prepend(ToolIcon.element(this.doc, icon));
    return b;
  }

  private button(label: string, disabled: boolean, onClick: () => void, tooltip?: string): HTMLButtonElement {
    const b = this.doc.createElement("button");
    b.setAttribute("role", "menuitem");
    b.textContent = label;
    b.disabled = disabled;
    if (tooltip) b.title = tooltip;
    b.addEventListener("click", () => {
      this.close();
      onClick();
    });
    return b;
  }
}
