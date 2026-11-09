/**
 * Editor tools that open in their own tab, and which selections they accept.
 * Shared by the in-page launcher, the side panel, the service worker (validation)
 * and the editors themselves, so the rules live in one place.
 */

import { ScanPlans, type ScanPlan } from "../scan/scan-plan.js";

export type ToolId = "split" | "panorama" | "edit" | "upscale";

export interface ToolSpec {
  id: ToolId;
  label: string;
  /** Caption under the tool's icon. */
  short: string;
  page: string;
  minPhotos: number;
  maxPhotos: number;
  /** Shown when the current selection doesn't fit. */
  hint: string;
}

export const TOOLS: Record<ToolId, ToolSpec> = {
  split: { id: "split", label: "Split into Photos", short: "Split", page: "split.html", minPhotos: 1, maxPhotos: 100, hint: "Select or open 1–100 scanned photos to split them into separate pictures." },
  panorama: { id: "panorama", label: "Create panorama", short: "Panorama", page: "panorama.html", minPhotos: 2, maxPhotos: 40, hint: "Select 2–40 overlapping photos to stitch them into a panorama." },
  edit: { id: "edit", label: "Edit with AI", short: "Edit", page: "edit.html", minPhotos: 1, maxPhotos: 1, hint: "Select or open one photo to edit it." },
  upscale: { id: "upscale", label: "Upscale: more pixels and detail", short: "Upscale", page: "upscale.html", minPhotos: 1, maxPhotos: 1, hint: "Select or open one photo to upscale it." },
};

export const TOOL_IDS = Object.keys(TOOLS) as ToolId[];

/** The library scan (finds work for tools across a date range, an album, a selection or the whole library). */
export const SCAN_PAGE = "scan.html";
export const SETTINGS_PAGE = "settings.html";
/** chrome.storage.session key prefix for a plan handed to a scan. */
export const SCAN_SELECTION_PREFIX = "pixlixir.scanSelection.";

/** What the service worker hands to a scan page: what to do, bound to an account. */
export interface ScanHandover {
  accountEmail: string;
  plan: ScanPlan;
}

/** The most items one scan accepts as a selection. */
export const MAX_SCAN_SELECTION = 5000;

/** Fix dates: photos and videos alike, run by the scan modal on what is selected. */
export class FixDatesTool {
  static readonly LABEL = "Fix dates from file names";
  static readonly SHORT = "Fix dates";
  static readonly HINT = "Select photos or videos to fix their dates from their file names.";

  static plan(items: readonly { mediaKey: string }[]): ScanPlan | null {
    if (items.length === 0 || items.length > MAX_SCAN_SELECTION) return null;
    return ScanPlans.datesOf(items.map((i) => i.mediaKey));
  }
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
