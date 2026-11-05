/** Which result tabs a scan has, and which one is on show. */

import type { DetectorId } from "../../scan/scan-detector.js";

export interface ScanTab {
  id: DetectorId;
  label: string;
  count: number;
}

export class ScanTabs {
  private static readonly ORDER: readonly { id: DetectorId; label: string }[] = [
    { id: "panorama", label: "Panoramas" },
    { id: "duplicates", label: "Duplicates" },
    { id: "dates", label: "Wrong dates" },
  ];

  /** One tab per thing this scan looks for, even when it found nothing. */
  static list(detectors: Record<DetectorId, boolean>, counts: Record<DetectorId, number>): ScanTab[] {
    return ScanTabs.ORDER.filter((t) => detectors[t.id]).map((t) => ({ ...t, count: counts[t.id] }));
  }

  /** The chosen tab if this scan has it, otherwise the first it has. */
  static active(detectors: Record<DetectorId, boolean>, chosen: DetectorId | null): DetectorId {
    if (chosen && detectors[chosen]) return chosen;
    return ScanTabs.ORDER.find((t) => detectors[t.id])?.id ?? "panorama";
  }
}
