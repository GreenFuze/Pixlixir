/**
 * Saved detector results, so later scans only analyse what changed. Listing stays cheap and
 * always runs; a detector stores its expensive per-sequence result under a signature of the
 * photos it looked at, so a sequence that gains or loses a photo is simply checked again.
 */

export interface ScanCache<T> {
  get(signature: string): Promise<T | null>;
  put(signature: string, value: T): Promise<void>;
}
