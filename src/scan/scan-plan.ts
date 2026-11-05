/** What one scan does: where it looks and what for. Chosen in the side panel, run by the scan modal. */

import { ErrorCode, PixError } from "../shared/errors.js";
import type { DetectorId } from "./scan-detector.js";
import type { ScanScope } from "./scan-scope.js";

export interface ScanPlan {
  scope: ScanScope;
  detectors: Record<DetectorId, boolean>;
  /** Ignore saved results and check every photo again. */
  recheck: boolean;
}

export class ScanPlans {
  /** Fixing the dates of chosen items, without looking for anything else. */
  static datesOf(mediaKeys: string[]): ScanPlan {
    return { scope: { kind: "selection", mediaKeys }, detectors: { panorama: false, dates: true, duplicates: false }, recheck: false };
  }

  static isoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /** Both days whole, in local time. */
  static dateRange(from: string, to: string): ScanScope {
    return { kind: "dateRange", fromMs: ScanPlans.localDayStart(from), toMs: ScanPlans.localDayStart(to) + 86_400_000 - 1 };
  }

  /** Midnight (local time) of a yyyy-mm-dd date, as epoch ms. */
  static localDayStart(iso: string): number {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) throw new PixError(ErrorCode.InvalidMessage, "Enter a valid date.", { value: iso });
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }
}
