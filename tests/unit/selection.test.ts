// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { SelectionObserver } from "../../src/gphotos/dom/selection.js";

const K1 = "AF1QipAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const K2 = "AF1QipBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function tile(key: string, label: string, checked: boolean): string {
  return `<div class="tile"><a href="./photo/${key}" aria-label="${label}"></a><div role="checkbox" aria-checked="${checked}"></div></div>`;
}

function doc(html: string): Document {
  return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
}

describe("SelectionObserver.read", () => {
  it("returns checked grid tiles with media types", () => {
    const d = doc(`<section>${tile(K1, "Photo - Landscape", true)}${tile(K2, "Video - Portrait", false)}</section>`);
    expect(SelectionObserver.read(d, "/")).toEqual({ kind: "grid", items: [{ mediaKey: K1, type: "photo" }] });
  });

  it("ignores date-group select-all checkboxes that span several tiles", () => {
    const d = doc(`<section><div role="checkbox" aria-checked="true"></div>${tile(K1, "Photo", false)}${tile(K2, "Photo", false)}</section>`);
    expect(SelectionObserver.read(d, "/")).toEqual({ kind: "none" });
  });

  it("falls back to the single-item viewer URL", () => {
    expect(SelectionObserver.read(doc(""), `/u/1/photo/${K2}`)).toEqual({ kind: "viewer", item: { mediaKey: K2, type: "unknown" } });
    expect(SelectionObserver.read(doc(""), `/album/X/photo/${K1}`)).toMatchObject({ kind: "viewer" });
  });
});
