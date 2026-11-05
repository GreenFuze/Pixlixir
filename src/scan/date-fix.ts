/**
 * Wrong dates: items whose capture date differs from the date in their file name, using the
 * account's known formats (filename-format.ts). The fix is in place: albums, sharing and edits
 * stay. Ported from the owner's Photo Date Fixer; see docs/architecture/adr/0007-filename-dates.md.
 */

import type { DateChange, ItemFileInfo, LibraryItem } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";
import type { FilenameFormats, FilenameStamp } from "./filename-format.js";
import type { ScanCache } from "./scan-cache.js";
import { ScanFailures, type DetectorStats, type ScanContext, type ScanDetector, type ScanFinding } from "./scan-detector.js";

const DAY_MS = 86_400_000;

export class DateCorrection {
  /** A name with a time this close to the current date already counts as correct. */
  static readonly TOLERANCE_MS = 120_000;

  /** The capture time this name asks for, or null when the item is already right. */
  static target(item: Pick<LibraryItem, "takenAtMs" | "timezoneOffsetMs">, stamp: FilenameStamp): number | null {
    const offset = item.timezoneOffsetMs;

    // Paragraph: a name with a time sets it (in UTC for names written in UTC, else on the photo's clock).
    if (stamp.hasTime) {
      const target = stamp.utc ? stamp.localMs : stamp.localMs - offset;
      return Math.abs(target - item.takenAtMs) > DateCorrection.TOLERANCE_MS ? target : null;
    }

    // Paragraph: a name with only a date changes the day and keeps the time of day (whole seconds).
    const local = item.takenAtMs + offset;
    if (Math.floor(local / DAY_MS) === Math.floor(stamp.localMs / DAY_MS)) return null;
    const timeOfDay = ((local % DAY_MS) + DAY_MS) % DAY_MS;
    return stamp.localMs + Math.floor(timeOfDay / 1000) * 1000 - offset;
  }
}

export interface DateFixFinding extends ScanFinding {
  detector: "dates";
  item: LibraryItem;
  fileName: string;
  mask: string;
  newTakenAtMs: number;
}

export interface FileInfoSource {
  readItemInfo(mediaKeys: string[]): Promise<ItemFileInfo[]>;
}

export class FilenameDateDetector implements ScanDetector<DateFixFinding> {
  static readonly NAMES_PER_REQUEST = 400;
  /** Bump when what is saved changes. */
  static readonly NAME_VERSION = 1;

  readonly id = "dates" as const;
  readonly label = "Wrong dates";
  readonly description = "Items whose date differs from the date in their file name.";

  constructor(
    private readonly source: FileInfoSource,
    private readonly formats: FilenameFormats,
    /** File names never change, so each is only read once (by dedup key, stable across albums). */
    private readonly names: ScanCache<string>,
  ) {}

  async analyze(items: readonly LibraryItem[], ctx: ScanContext, emit: (finding: DateFixFinding) => void): Promise<DetectorStats> {
    const stats: DetectorStats = { photosReused: 0, photosChecked: 0, failures: [], unmatchedNames: 0 };
    let unmatched = 0;
    const editable = items.filter((i) => i.editable !== false);
    const inspect = (item: LibraryItem, fileName: string) => {
      const stamp = this.formats.parse(fileName);
      if (!stamp) unmatched++;
      const target = stamp && DateCorrection.target(item, stamp);
      if (stamp && target !== null) emit({ id: `dates:${item.mediaKey}`, detector: "dates", mediaKeys: [item.mediaKey], item, fileName, mask: stamp.mask, newTakenAtMs: target });
    };

    // Paragraph: names read before.
    const unread: LibraryItem[] = [];
    for (const item of editable) {
      const known = await this.names.get(FilenameDateDetector.nameKey(item));
      if (known === null) {
        unread.push(item);
        continue;
      }
      stats.photosReused++;
      inspect(item, known);
    }

    // Paragraph: the rest, in batches. One failed batch is reported and the others go on.
    let unreadable = 0;
    for (let i = 0; i < unread.length; i += FilenameDateDetector.NAMES_PER_REQUEST) {
      if (ctx.signal.aborted) throw new PixError(ErrorCode.Cancelled, "The scan was stopped");
      ctx.progress("Reading file names", i, unread.length);
      const batch = unread.slice(i, i + FilenameDateDetector.NAMES_PER_REQUEST);
      try {
        const info = new Map((await this.source.readItemInfo(batch.map((b) => b.mediaKey))).map((x) => [x.mediaKey, x]));
        for (const item of batch) {
          const fileName = info.get(item.mediaKey)?.fileName;
          if (!fileName) {
            unreadable++;
            continue;
          }
          await this.names.put(FilenameDateDetector.nameKey(item), fileName);
          inspect(item, fileName);
        }
      } catch (err) {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not read file names");
        if (ScanFailures.stopsTheScan(e)) throw e;
        stats.failures.push(e.toJSON());
      }
      stats.photosChecked += batch.length;
    }
    stats.unmatchedNames = unmatched;
    if (unreadable > 0) stats.failures.push(new PixError(ErrorCode.MediaFetchFailed, `${unreadable} file name${unreadable === 1 ? "" : "s"} could not be read`, { unreadable }).toJSON());
    return stats;
  }

  private static nameKey(item: LibraryItem): string {
    return `v${FilenameDateDetector.NAME_VERSION}|${item.dedupKey}`;
  }
}

/** One date to write, and how to find the item again to check it. */
export interface PlannedDate extends DateChange {
  mediaKey: string;
}

export interface DateWriter extends FileInfoSource {
  setDates(changes: DateChange[]): Promise<void>;
}

/** Writes dates in batches and reads every batch back: a date that did not stick stops the run. */
export class DateFixApplier {
  static readonly BATCH = 100;

  constructor(private readonly writer: DateWriter) {}

  /** `onApplied` gets the media keys confirmed so far, before any failure is thrown. */
  async run(changes: readonly PlannedDate[], shouldStop: () => boolean, onApplied: (mediaKeys: string[]) => Promise<void> | void): Promise<void> {
    for (let i = 0; i < changes.length; i += DateFixApplier.BATCH) {
      if (shouldStop()) return;
      const batch = changes.slice(i, i + DateFixApplier.BATCH);
      await this.writer.setDates(batch.map(({ dedupKey, takenAtMs, timezoneOffsetMs }) => ({ dedupKey, takenAtMs, timezoneOffsetMs })));

      // Paragraph: read back. Google stores whole seconds, so that is what is compared.
      const back = new Map((await this.writer.readItemInfo(batch.map((c) => c.mediaKey))).map((x) => [x.mediaKey, x]));
      const seconds = (ms: number) => Math.floor(ms / 1000);
      const stuck = (c: PlannedDate) => {
        const now = back.get(c.mediaKey);
        return now !== undefined && seconds(now.takenAtMs) === seconds(c.takenAtMs) && seconds(now.timezoneOffsetMs) === seconds(c.timezoneOffsetMs);
      };
      const good = batch.filter(stuck);
      await onApplied(good.map((c) => c.mediaKey));
      if (good.length < batch.length) {
        const failed = batch.length - good.length;
        throw new PixError(ErrorCode.DateNotApplied, `${failed} of ${batch.length} items did not get the new date. Stopped.`, { failed, batch: batch.length });
      }
    }
  }
}
