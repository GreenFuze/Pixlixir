/**
 * Pictures of what each tool does, drawn from data rather than markup, so the side panel (Preact)
 * and the in-page launcher (plain DOM on Google's page) share them without any innerHTML.
 * All are 96 x 40: before on the left, an arrow, after on the right.
 */

export interface IconShape {
  tag: "rect" | "path" | "circle";
  attrs: Record<string, string | number>;
}

export type ToolIconId = "split" | "panorama" | "dates";

const SVG_NS = "http://www.w3.org/2000/svg";
const INK = "#8b85a0";
const SKY = "#7c5cff";
const LAND = "#e9e4ff";
const OK = "#2fb37a";

class IconPainter {
  /** A plain white sheet. */
  static sheet(x: number, y: number, w: number, h: number): IconShape {
    return { tag: "rect", attrs: { x, y, width: w, height: h, rx: 2, fill: "#fff", stroke: INK, "stroke-width": 1 } };
  }

  /** A small photo: sky and one hill, recognisable at this size. */
  static photo(x: number, y: number, w: number, h: number): IconShape[] {
    const ridge = `M${x} ${y + h}L${x + w * 0.35} ${y + h * 0.45}L${x + w * 0.6} ${y + h * 0.72}L${x + w * 0.8} ${y + h * 0.55}L${x + w} ${y + h * 0.8}V${y + h}Z`;
    return [
      { tag: "rect", attrs: { x, y, width: w, height: h, rx: 1.5, fill: SKY } },
      { tag: "path", attrs: { d: ridge, fill: LAND } },
    ];
  }

  static arrow(x: number): IconShape[] {
    return [{ tag: "path", attrs: { d: `M${x} 20H${x + 11}M${x + 7} 15.5L${x + 11.5} 20L${x + 7} 24.5`, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" } }];
  }
}

const { sheet, photo, arrow } = IconPainter;

export const TOOL_ICONS: Record<ToolIconId, IconShape[]> = {
  // One scanned sheet holding three prints -> the three prints on their own.
  split: [
    sheet(4, 3, 34, 34),
    ...photo(7, 6, 13, 12), ...photo(22, 6, 13, 12), ...photo(14, 21, 13, 12),
    ...arrow(42),
    ...photo(60, 3, 15, 15), ...photo(78, 3, 15, 15), ...photo(69, 22, 15, 15),
  ],

  // Three photos of one view -> a single wide one.
  panorama: [
    ...photo(3, 10, 11, 20), ...photo(16, 10, 11, 20), ...photo(29, 10, 11, 20),
    ...arrow(44),
    { tag: "rect", attrs: { x: 60, y: 11, width: 33, height: 18, rx: 1.5, fill: SKY } },
    { tag: "path", attrs: { d: "M60 29L68 18L74 24L81 16L93 27V29Z", fill: LAND } },
  ],

  // A file with a name -> a calendar with the right day ticked.
  dates: [
    sheet(10, 3, 24, 34),
    { tag: "path", attrs: { d: "M14 10H30M14 16H30M14 22H24", stroke: INK, "stroke-width": 2, "stroke-linecap": "round", fill: "none" } },
    ...arrow(42),
    sheet(62, 7, 28, 28),
    { tag: "rect", attrs: { x: 62, y: 7, width: 28, height: 7, rx: 2, fill: SKY } },
    { tag: "path", attrs: { d: "M69 25L74 30L84 19", stroke: OK, "stroke-width": 2.6, "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" } },
  ],
};

export class ToolIcon {
  static readonly VIEW_BOX = "0 0 96 40";

  /** The icon as DOM nodes, for pages that do not use Preact. Never parses a string. */
  static element(doc: Document, id: ToolIconId): SVGSVGElement {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", ToolIcon.VIEW_BOX);
    svg.setAttribute("aria-hidden", "true");
    for (const shape of TOOL_ICONS[id]) {
      const node = doc.createElementNS(SVG_NS, shape.tag);
      for (const [name, value] of Object.entries(shape.attrs)) node.setAttribute(name, String(value));
      svg.append(node);
    }
    return svg;
  }
}
