/**
 * Modal over Google Photos hosting an extension page in an iframe (the library scan).
 * The page keeps running while minimized; closing removes the iframe, which stops its work.
 * Lives in a closed shadow root so Google's CSS and scripts cannot reach it.
 *
 * RAII: open() creates the iframe, close() destroys it.
 */

const STYLE = `
  :host { all: initial; }
  .backdrop { position: fixed; inset: 0; z-index: 2147482000; display: grid; place-items: center; background: rgba(0,0,0,.55); }
  .backdrop.hidden { display: none; }
  iframe { width: min(1180px, 94vw); height: 90vh; border: 0; border-radius: 14px; background: #15121f; box-shadow: 0 16px 48px rgba(0,0,0,.5); }
`;

export class ToolModal {
  readonly #doc: Document;
  #host: HTMLElement | null = null;
  #backdrop: HTMLDivElement | null = null;
  #frame: HTMLIFrameElement | null = null;

  constructor(doc: Document) {
    this.#doc = doc;
  }

  get isOpen(): boolean {
    return this.#host !== null;
  }

  get isMinimized(): boolean {
    return this.#backdrop?.classList.contains("hidden") ?? false;
  }

  open(url: string): void {
    // Paragraph: a running page is never replaced; bring it back instead.
    if (this.isOpen) {
      this.restore();
      return;
    }

    // Paragraph: build the overlay.
    const host = this.#doc.createElement("pixlixir-modal");
    const root = host.attachShadow({ mode: "closed" });
    const style = this.#doc.createElement("style");
    style.textContent = STYLE;
    const backdrop = this.#doc.createElement("div");
    backdrop.className = "backdrop";
    const frame = this.#doc.createElement("iframe");
    frame.src = url;
    frame.title = "Pixlixir";
    backdrop.append(frame);
    root.append(style, backdrop);
    this.#doc.documentElement.append(host);
    frame.focus();
    this.#host = host;
    this.#backdrop = backdrop;
    this.#frame = frame;
  }

  minimize(): void {
    this.#backdrop?.classList.add("hidden");
  }

  restore(): void {
    this.#backdrop?.classList.remove("hidden");
    this.#frame?.focus();
  }

  close(): void {
    this.#host?.remove();
    this.#host = null;
    this.#backdrop = null;
    this.#frame = null;
  }
}
