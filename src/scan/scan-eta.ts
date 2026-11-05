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

  static format(seconds: number): string {
    if (seconds < 60) return "less than a minute left";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `about ${minutes} min left`;
    return `about ${Math.round(minutes / 6) / 10} h left`;
  }
}
