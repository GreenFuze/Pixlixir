/**
 * Detector contract for library scans. A detector looks at the listed items and emits
 * findings as it goes; the scan page shows them and offers each detector's bulk action.
 * Panoramas are the first detector; metadata problems, duplicates etc. plug in here.
 */

import type { LibraryItem } from "../domain/types.js";

export type DetectorId = "panorama";

export interface ScanFinding {
  /** Stable within one scan. */
  id: string;
  detector: DetectorId;
  /** Items the finding is about, in capture order. */
  mediaKeys: string[];
}

export interface ScanContext {
  signal: AbortSignal;
  /** Human-readable step, with optional counts for a progress bar. */
  progress(step: string, done?: number, total?: number): void;
}

export interface ScanDetector<F extends ScanFinding = ScanFinding> {
  readonly id: DetectorId;
  readonly label: string;
  readonly description: string;
  analyze(items: readonly LibraryItem[], ctx: ScanContext, emit: (finding: F) => void): Promise<void>;
}
