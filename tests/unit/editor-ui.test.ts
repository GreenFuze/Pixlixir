// @vitest-environment happy-dom
import { h, render } from "preact";
import { describe, expect, it } from "vitest";
import { useSnapshot } from "../../src/extension/editor/editor-ui.js";

class Store {
  snapshot = "starting";
  readonly #listeners = new Set<(s: string) => void>();

  subscribe(fn: (s: string) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  publish(s: string): void {
    this.snapshot = s;
    for (const fn of this.#listeners) fn(s);
  }
}

function View(props: { store: Store }) {
  return h("p", null, useSnapshot(props.store));
}

const settled = () => new Promise((r) => setTimeout(r, 50));

describe("useSnapshot", () => {
  it("shows a snapshot published before the page subscribed (a fast start-up failure)", async () => {
    const store = new Store();
    const root = document.createElement("div");
    render(h(View, { store }), root);
    store.publish("failed");
    await settled();
    expect(root.textContent).toBe("failed");
  });

  it("follows later snapshots", async () => {
    const store = new Store();
    const root = document.createElement("div");
    render(h(View, { store }), root);
    await settled();
    store.publish("ready");
    await settled();
    expect(root.textContent).toBe("ready");
  });
});
