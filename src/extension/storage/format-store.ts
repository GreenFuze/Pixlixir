/** The filename formats of each Google account (chrome.storage.local). An account starts with the defaults. */

import { z } from "zod";
import { FilenameFormat, FilenameFormats, type FilenameFormatEntry } from "../../scan/filename-format.js";
import { ErrorCode, PixError } from "../../shared/errors.js";

const Entries = z.array(z.object({ mask: z.string(), utc: z.boolean(), saved: z.boolean().optional() }));

export class FormatStore {
  static readonly PREFIX = "pixlixir.filenameFormats.";

  constructor(private readonly accountEmail: string) {}

  private get key(): string {
    return FormatStore.PREFIX + this.accountEmail;
  }

  async load(): Promise<FilenameFormatEntry[]> {
    const stored = (await chrome.storage.local.get(this.key))[this.key];
    if (stored === undefined) return [...FilenameFormats.DEFAULTS];
    const parsed = Entries.safeParse(stored);
    if (!parsed.success) throw new PixError(ErrorCode.StorageFailed, "The saved filename formats could not be read", { account: this.accountEmail });
    return parsed.data;
  }

  /** Every entry must be a valid format; nothing is saved otherwise. */
  async save(entries: readonly FilenameFormatEntry[]): Promise<void> {
    for (const entry of entries) new FilenameFormat(entry);
    await chrome.storage.local.set({ [this.key]: entries });
  }
}
