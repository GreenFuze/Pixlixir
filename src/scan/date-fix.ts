/**
 * Wrong dates: items whose capture date differs from the date in their file name, using the
 * account's known formats (filename-format.ts). The fix is in place: albums, sharing and edits
 * stay. Ported from the owner's Photo Date Fixer; see docs/architecture/adr/0007-filename-dates.md.
 */

import pLimit from "p-limit";
import type { DateChange, ItemFileInfo, LibraryItem } from "../domain/types.js";
import { ErrorCode, PixError } from "../shared/errors.js";
import { FileDetailsReader, type FileDetails } from "./file-details.js";
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
  /** The name's date is probably when the file was saved: a copy, whose date only its original can give. */
  exportDate: boolean;
  /** What decided that: the file's own date, the name alone, or many files sharing the name's day. Null for a plain wrong date. */
  copyReason: "file" | "name" | "group" | null;
  /** The file's own date backs the name. */
  fileAgrees: boolean;
  /** The date taken in the file, as wall-clock time written as if it were UTC. Null when it has none or was not read. */
  fileTakenLocalMs: number | null;
}

/**
 * One file can show it was saved, not taken, when its name is nothing but a date: with a copy
 * counter, as "2022-12-02 (3).jpg", or at a size made for sharing. Cameras add more to a name.
 */
export class SavedCopyName {
  static readonly MAX_SHARED_SIDE = 1080;
  private static readonly DATE_ONLY = /^\d{4}[-_.]?\d{2}[-_.]?\d{2}( ?\(\d+\))?\.\w+$/;

  static matches(fileName: string, item: Pick<LibraryItem, "width" | "height">): boolean {
    const name = SavedCopyName.DATE_ONLY.exec(fileName);
    if (!name) return false;
    const side = Math.max(item.width, item.height);
    return name[1] !== undefined || (side > 0 && side <= SavedCopyName.MAX_SHARED_SIDE);
  }
}

/**
 * Tells a date a file was taken from a date it was saved. Photos named after one day but dated
 * months or years apart were not all taken that day: they were exported together. Google's
 * current date may be wrong too, so this only stops the name from being trusted.
 */
export class ExportDateGuard {
  static readonly MIN_FILES = 5;
  static readonly MIN_SPAN_DAYS = 30;

  /** Marks the findings, the ones that are probably right first. A file whose own date backs its name is never marked. */
  static apply(findings: readonly DateFixFinding[]): DateFixFinding[] {
    // Paragraph: findings named after the same day.
    const byDay = new Map<number, DateFixFinding[]>();
    for (const f of findings) {
      const day = Math.floor((f.newTakenAtMs + f.item.timezoneOffsetMs) / DAY_MS);
      byDay.set(day, [...(byDay.get(day) ?? []), f]);
    }

    // Paragraph: enough of them, whose current dates are far apart.
    const marked = new Set<DateFixFinding>();
    for (const group of byDay.values()) {
      const dates = group.map((f) => f.item.takenAtMs);
      if (group.length >= ExportDateGuard.MIN_FILES && Math.max(...dates) - Math.min(...dates) >= ExportDateGuard.MIN_SPAN_DAYS * DAY_MS) for (const f of group) marked.add(f);
    }
    const all = findings.map((f): DateFixFinding => (f.exportDate || !marked.has(f) || f.fileAgrees ? f : { ...f, exportDate: true, copyReason: "group" }));
    return [...all.filter((f) => !f.exportDate), ...all.filter((f) => f.exportDate)];
  }
}

export interface FileInfoSource {
  readItemInfo(mediaKeys: string[]): Promise<ItemFileInfo[]>;
}

export interface FileHeadSource {
  fileHead(baseUrl: string): Promise<Uint8Array>;
}

interface NamedFinding {
  finding: DateFixFinding;
  stamp: FilenameStamp;
}

export class FilenameDateDetector implements ScanDetector<DateFixFinding> {
  static readonly NAMES_PER_REQUEST = 400;
  /** Files read at once for their details. */
  static readonly PARALLEL_HEADS = 6;
  /** Bump when what is saved changes. */
  static readonly NAME_VERSION = 1;
  static readonly DETAILS_VERSION = 1;

  readonly id = "dates" as const;
  readonly label = "Wrong dates";
  readonly description = "Items whose date differs from the date in their file name.";

  constructor(
    private readonly source: FileInfoSource,
    private readonly formats: FilenameFormats,
    /** File names never change, so each is only read once (by dedup key, stable across albums). */
    private readonly names: ScanCache<string>,
    private readonly heads: FileHeadSource,
  ) {}

  async analyze(items: readonly LibraryItem[], ctx: ScanContext, emit: (finding: DateFixFinding) => void): Promise<DetectorStats> {
    const stats: DetectorStats = { photosReused: 0, photosChecked: 0, failures: [], unmatchedNames: 0 };
    let unmatched = 0;
    const editable = items.filter((i) => i.editable !== false);
    const named: NamedFinding[] = [];
    const inspect = (item: LibraryItem, fileName: string) => {
      const stamp = this.formats.parse(fileName);
      if (!stamp) unmatched++;
      if (!stamp || stamp.saved) return;
      const target = DateCorrection.target(item, stamp);
      if (target !== null) named.push({ stamp, finding: { id: `dates:${item.mediaKey}`, detector: "dates", mediaKeys: [item.mediaKey], item, fileName, mask: stamp.mask, newTakenAtMs: target, exportDate: false, copyReason: null, fileAgrees: false, fileTakenLocalMs: null } });
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
    // Paragraph: the file's own date decides where it has one; the name's shape and the guard judge the rest. The guard needs all of them, so findings are reported together.
    const judged = await this.judge(named, ctx, stats);
    for (const finding of ExportDateGuard.apply(judged)) emit(finding);
    stats.unmatchedNames = unmatched;
    if (unreadable > 0) stats.failures.push(new PixError(ErrorCode.MediaFetchFailed, `${unreadable} file name${unreadable === 1 ? "" : "s"} could not be read`, { unreadable }).toJSON());
    return stats;
  }

  /** Compares each finding's name with its file. A file that cannot be read is counted, and judged by its name. */
  private async judge(named: readonly NamedFinding[], ctx: ScanContext, stats: DetectorStats): Promise<DateFixFinding[]> {
    const limit = pLimit(FilenameDateDetector.PARALLEL_HEADS);
    let done = 0;
    let unreadable = 0;
    const stop: { error: PixError | null } = { error: null };
    const judged = await Promise.all(named.map(({ finding, stamp }) => limit(async (): Promise<DateFixFinding> => {
      const byName = (): DateFixFinding => (!stamp.hasTime && SavedCopyName.matches(finding.fileName, finding.item) ? { ...finding, exportDate: true, copyReason: "name" } : finding);
      if (finding.item.type !== "photo" || stop.error) return byName();
      if (ctx.signal.aborted) {
        stop.error = new PixError(ErrorCode.Cancelled, "The scan was stopped");
        return byName();
      }
      ctx.progress("Reading file details", done, named.length);
      try {
        const details = await this.details(finding.item);
        const verdict = FileDetailsReader.compare(details, stamp.localMs);
        const fileTakenLocalMs = details?.takenLocalMs ?? null;
        done++;
        if (verdict === "disagrees") return { ...finding, fileTakenLocalMs, exportDate: true, copyReason: "file" };
        return verdict === "agrees" ? { ...finding, fileTakenLocalMs, fileAgrees: true } : { ...byName(), fileTakenLocalMs };
      } catch (err) {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.MediaFetchFailed, "Could not read a file");
        if (ScanFailures.stopsTheScan(e)) stop.error ??= e;
        else unreadable++;
        done++;
        return byName();
      }
    })));
    if (stop.error) throw stop.error;
    if (unreadable > 0) stats.failures.push(new PixError(ErrorCode.MediaFetchFailed, `${unreadable} file${unreadable === 1 ? "" : "s"} could not be read for their details`, { unreadable }).toJSON());
    return judged;
  }

  /** A file's details never change, so each is only read once. */
  private async details(item: LibraryItem): Promise<FileDetails | null> {
    const key = `details-v${FilenameDateDetector.DETAILS_VERSION}|${item.dedupKey}`;
    const saved = await this.names.get(key);
    if (saved !== null) return JSON.parse(saved) as FileDetails | null;
    const details = FileDetailsReader.parse(await this.heads.fileHead(item.baseUrl));
    await this.names.put(key, JSON.stringify(details));
    return details;
  }

  private static nameKey(item: LibraryItem): string {
    return `v${FilenameDateDetector.NAME_VERSION}|${item.dedupKey}`;
  }
}

/** One date to write, and how to find the item again to check it. */
export interface PlannedDate extends DateChange {
  mediaKey: string;
  /** Names the item if its date does not stick. */
  fileName: string;
}

export interface DateWriter extends FileInfoSource {
  setDates(changes: DateChange[]): Promise<void>;
}

/** Writes dates in batches and reads every batch back: a date that did not stick stops the run. */
export class DateFixApplier {
  static readonly BATCH = 100;
  private static readonly NAMES_IN_ERROR = 3;

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
        const failed = batch.filter((c) => !stuck(c));
        const names = failed.slice(0, DateFixApplier.NAMES_IN_ERROR).map((c) => c.fileName).join(", ");
        throw new PixError(ErrorCode.DateNotApplied, `${failed.length} of ${batch.length} items did not get the new date: ${names}. Stopped.`, {
          failed: failed.length,
          batch: batch.length,
          examples: failed.slice(0, DateFixApplier.NAMES_IN_ERROR).map((c) => ({ fileName: c.fileName, mediaKey: c.mediaKey, wantedMs: c.takenAtMs, wantedOffsetMs: c.timezoneOffsetMs, gotMs: back.get(c.mediaKey)?.takenAtMs ?? null, gotOffsetMs: back.get(c.mediaKey)?.timezoneOffsetMs ?? null })),
        });
      }
    }
  }
}
