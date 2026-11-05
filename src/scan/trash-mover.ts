/**
 * Moves items to Google Photos' trash and confirms they arrived. The only way out of the
 * library Pixlixir has: items stay recoverable in Google's Trash, and there is no permanent delete.
 */

import type { Page } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";

export interface TrashGateway {
  moveToTrash(dedupKeys: string[]): Promise<void>;
  listTrash(page: string | null): Promise<Page<string>>;
}

export class TrashMover {
  static readonly BATCH = 100;
  /** The trash may take a moment to list what was just moved. */
  static readonly CHECKS = 4;
  static readonly CHECK_WAIT_MS = 1500;

  constructor(
    private readonly trash: TrashGateway,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** `onMoved` gets the keys confirmed in the trash so far, before any failure is thrown. */
  async run(dedupKeys: readonly string[], onMoved: (keys: string[]) => Promise<void> | void): Promise<void> {
    const keys = [...new Set(dedupKeys)];
    for (let i = 0; i < keys.length; i += TrashMover.BATCH) {
      const batch = keys.slice(i, i + TrashMover.BATCH);
      await this.trash.moveToTrash(batch);

      // Paragraph: a move only counts once the trash lists it.
      const missing = await this.missingFromTrash(batch);
      await onMoved(batch.filter((k) => !missing.has(k)));
      if (missing.size > 0) {
        throw new PixError(ErrorCode.TrashNotApplied, `${missing.size} of ${batch.length} photos did not reach the trash. Stopped.`, { missing: missing.size, batch: batch.length });
      }
    }
  }

  private async missingFromTrash(keys: readonly string[]): Promise<Set<string>> {
    const missing = new Set(keys);
    for (let attempt = 0; attempt < TrashMover.CHECKS && missing.size > 0; attempt++) {
      if (attempt > 0) await this.wait(TrashMover.CHECK_WAIT_MS);
      let page: string | null = null;
      do {
        const listed: Page<string> = await this.trash.listTrash(page);
        for (const k of listed.items) missing.delete(k);
        page = listed.next;
      } while (page !== null && missing.size > 0);
    }
    return missing;
  }
}
