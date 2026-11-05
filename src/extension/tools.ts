/**
 * Editor tools that open in their own tab, and which selections they accept.
 * Shared by the in-page launcher, the side panel, the service worker (validation)
 * and the editors themselves, so the rules live in one place.
 */

export type ToolId = "split" | "panorama";

export interface ToolSpec {
  id: ToolId;
  label: string;
  page: string;
  minPhotos: number;
  maxPhotos: number;
  /** Shown when the current selection doesn't fit. */
  hint: string;
}

export const TOOLS: Record<ToolId, ToolSpec> = {
  split: { id: "split", label: "Split into Photos", page: "split.html", minPhotos: 1, maxPhotos: 100, hint: "Select or open 1–100 scanned photos to split them into separate pictures." },
  panorama: { id: "panorama", label: "Create panorama", page: "panorama.html", minPhotos: 2, maxPhotos: 40, hint: "Select 2–40 overlapping photos to stitch them into a panorama." },
};

export const TOOL_IDS = Object.keys(TOOLS) as ToolId[];

/** The library scan (finds work for tools across a date range, an album, a selection or the whole library). */
export const SCAN_PAGE = "scan.html";
export const SCAN_HINT = "Find panoramas and wrong dates in your library.";
export const SETTINGS_PAGE = "settings.html";
/** chrome.storage.session key prefix for a selection handed to a scan. */
export const SCAN_SELECTION_PREFIX = "pixlixir.scanSelection.";

/** What the service worker hands to a scan page: selected photos, bound to their account. */
export interface ScanHandover {
  accountEmail: string;
  mediaKeys: string[];
}

export class ToolEligibility {
  /** Media keys the tool would open with for this selection, or null if the selection doesn't fit. */
  static mediaKeys(tool: ToolId, items: readonly { mediaKey: string; type: string }[]): string[] | null {
    const spec = TOOLS[tool];
    if (items.some((i) => i.type === "video")) return null;
    if (items.length < spec.minPhotos || items.length > spec.maxPhotos) return null;
    return items.map((i) => i.mediaKey);
  }
}
