/** Time-left estimate for a counted stage of a scan (linear in items done so far). */
export class ScanEta {
  #startedMs: number | null = null;
  #total = 0;

  /** Seconds left, or null until at least one item has finished. Restarts when the total changes. */
  update(done: number, total: number, nowMs: number): number | null {
    if (this.#startedMs === null || total !== this.#total) {
      this.#startedMs = nowMs;
      this.#total = total;
    }
    if (done <= 0 || done >= total) return done >= total ? 0 : null;
    return Math.round(((nowMs - this.#startedMs) / done) * (total - done) / 1000);
  }

  /** How long something took. */
  static elapsed(seconds: number): string {
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  static format(seconds: number): string {
    if (seconds < 60) return "less than a minute left";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `about ${minutes} min left`;
    return `about ${Math.round(minutes / 6) / 10} h left`;
  }
}
