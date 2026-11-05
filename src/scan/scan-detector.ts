/**
 * Detector contract for library scans. A detector looks at the listed items and emits
 * findings as it goes; the scan page shows them and offers each detector's bulk action.
 * Panoramas are the first detector; metadata problems, duplicates etc. plug in here.
 */

import type { LibraryItem } from "../domain/types.js";
import { ErrorCode, type PixError, type SerializedError } from "../shared/errors.js";

export type DetectorId = "panorama" | "dates" | "duplicates";

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

/** How a detector's run went. */
export interface DetectorStats {
  /** Photos answered from saved results, without analysing them again. */
  photosReused: number;
  /** Photos analysed in this run. */
  photosChecked: number;
  /** Parts that could not be analysed (the rest of the scan continued). */
  failures: SerializedError[];
  /** File names that match none of the account's formats. */
  unmatchedNames?: number;
}

export class ScanFailures {
  /** Problems that would hit everything that follows, and the user stopping the scan. */
  static stopsTheScan(e: PixError): boolean {
    const stopping: ErrorCode[] = [ErrorCode.Cancelled, ErrorCode.AccountMismatch, ErrorCode.TabNotBound, ErrorCode.SessionUnavailable, ErrorCode.RuntimeUnavailable, ErrorCode.StorageFailed];
    return stopping.includes(e.code);
  }
}

export interface ScanDetector<F extends ScanFinding = ScanFinding> {
  readonly id: DetectorId;
  readonly label: string;
  readonly description: string;
  analyze(items: readonly LibraryItem[], ctx: ScanContext, emit: (finding: F) => void): Promise<DetectorStats>;
}
