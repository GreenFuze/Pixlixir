/**
 * Persistent job records (IndexedDB). Jobs survive editor reloads and
 * service-worker restarts; saved outputs are recorded per print so a retry
 * never uploads the same print twice.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { AdjustmentPresets, type Adjustments } from "../../imaging/enhance/adjustments.js";
import type { Quad } from "../../imaging/geometry.js";
import type { StitchSettings } from "../../imaging/panorama/stitch-runtime.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";

export type SplitJobStatus = "editing" | "saving" | "done" | "partial" | "failed";

export interface SplitPrintRecord {
  id: string;
  quad: Quad;
  /** Quarter turns clockwise applied to the rectified output. */
  rotation: number;
  included: boolean;
  confidence: number | null;
  /** Fixes applied to this photo (auto defaults, user tweaks and brush strokes). */
  adjustments: Adjustments;
  saved: { mediaKey: string; webUrl: string; fileName: string } | null;
  error: SerializedError | null;
}

export interface SplitJob {
  id: string;
  kind: "split";
  accountEmail: string;
  sourceMediaKey: string;
  sourceFileName: string | null;
  sourceWidth: number;
  sourceHeight: number;
  status: SplitJobStatus;
  prints: SplitPrintRecord[];
  createdAt: number;
  updatedAt: number;
}

/** What a saved panorama took over from its photos (recorded so the user can see it). */
export interface InheritedRecord {
  takenAtMs: number | null;
  location: boolean;
  description: boolean;
  albums: string[];
  /** Post-upload steps that failed, as messages. */
  problems: string[];
}

export interface PanoramaJob {
  id: string;
  kind: "panorama";
  /** Set when the panorama was created in bulk from a library scan (one id per run). */
  batchId?: string | null;
  inherited?: InheritedRecord | null;
  accountEmail: string;
  /** First source (keeps the bySource index meaningful); all sources are in sourceMediaKeys. */
  sourceMediaKey: string;
  sourceMediaKeys: string[];
  /** Sources that made it into the saved panorama. */
  usedMediaKeys: string[];
  /** Their dedup keys (stable across library and album views, unlike album item keys). */
  usedDedupKeys?: string[];
  /** Originals the user moved to trash after saving. Written before the first move. */
  originalsTrash?: { dedupKeys: string[]; moved: string[]; state: "moving" | "moved" | "failed" } | null;
  settings: StitchSettings;
  status: "editing" | "saving" | "done" | "failed";
  saved: { mediaKey: string; webUrl: string; fileName: string; width: number; height: number } | null;
  error: SerializedError | null;
  createdAt: number;
  updatedAt: number;
}

/** One planned date change, kept so it can be undone. */
export interface DateFixRecord {
  mediaKey: string;
  dedupKey: string;
  fileName: string;
  oldTakenAtMs: number;
  newTakenAtMs: number;
  timezoneOffsetMs: number;
  /** When the run changes the time zone too, as when a date comes from an original. */
  oldTimezoneOffsetMs?: number;
  applied: boolean;
}

/** A run of date fixes. Written before the first change, so the old dates can never be lost. */
export interface DateFixJob {
  id: string;
  kind: "dateFix";
  accountEmail: string;
  sourceMediaKey: string;
  changes: DateFixRecord[];
  status: "saving" | "done" | "partial" | "failed" | "undone";
  error: SerializedError | null;
  createdAt: number;
  updatedAt: number;
}

/** Copies moved to trash from the duplicates results. Written before the first move. */
export interface DuplicateTrashJob {
  id: string;
  kind: "duplicateTrash";
  accountEmail: string;
  sourceMediaKey: string;
  dedupKeys: string[];
  moved: string[];
  status: "saving" | "done" | "partial" | "failed";
  error: SerializedError | null;
  createdAt: number;
  updatedAt: number;
}

/** One change in an Edit session: what made it, and what it was asked. */
export interface EditStep {
  by: string;
  prompt: string | null;
}

/** A photo saved from Edit. Written before the upload. */
export interface EditJob {
  id: string;
  kind: "edit";
  accountEmail: string;
  sourceMediaKey: string;
  sourceFileName: string | null;
  steps: EditStep[];
  status: "saving" | "done" | "failed";
  saved: { mediaKey: string; webUrl: string; fileName: string } | null;
  error: SerializedError | null;
  createdAt: number;
  updatedAt: number;
}

export type PixJob = SplitJob | PanoramaJob | DateFixJob | DuplicateTrashJob | EditJob;

interface PixDb extends DBSchema {
  jobs: { key: string; value: PixJob; indexes: { bySource: [string, string]; byUpdated: number } };
}

export class JobStore {
  static readonly DB_NAME = "pixlixir";
  static readonly VERSION = 1;

  private constructor(private readonly db: IDBPDatabase<PixDb>) {}

  static async open(): Promise<JobStore> {
    try {
      const db = await openDB<PixDb>(JobStore.DB_NAME, JobStore.VERSION, {
        upgrade(d) {
          const jobs = d.createObjectStore("jobs", { keyPath: "id" });
          jobs.createIndex("bySource", ["accountEmail", "sourceMediaKey"]);
          jobs.createIndex("byUpdated", "updatedAt");
        },
      });
      return new JobStore(db);
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.StorageFailed, "Could not open Pixlixir storage");
    }
  }

  close(): void {
    this.db.close();
  }

  async put<J extends PixJob>(job: J): Promise<J> {
    const stored = { ...job, updatedAt: Date.now() };
    await this.db.put("jobs", stored);
    return stored;
  }

  /** Every read is per account: a job of another account counts as not found. */
  async get(accountEmail: string, id: string): Promise<PixJob> {
    const job = await this.db.get("jobs", id);
    if (!job || job.accountEmail !== accountEmail) throw new PixError(ErrorCode.JobNotFound, `Job ${id} not found`, { id });
    return job.kind === "split" ? JobStore.upgrade(job) : job;
  }

  /** Jobs written by v0.1 have no per-photo adjustments: give them the auto defaults. */
  static upgrade(job: SplitJob): SplitJob {
    return { ...job, prints: job.prints.map((p) => ((p as Partial<SplitPrintRecord>).adjustments ? p : { ...p, adjustments: AdjustmentPresets.auto() })) };
  }

  /** Most recent unfinished split job for a source item, so the split editor can resume it. */
  async latestOpenForSource(accountEmail: string, mediaKey: string): Promise<SplitJob | null> {
    const all = await this.db.getAllFromIndex("jobs", "bySource", [accountEmail, mediaKey]);
    const open = all.filter((j): j is SplitJob => j.kind === "split" && j.status !== "done").sort((a, b) => b.updatedAt - a.updatedAt);
    return open[0] ? JobStore.upgrade(open[0]) : null;
  }

  /** Saved panoramas of an account (to recognise photo groups that already have one). */
  async savedPanoramas(accountEmail: string): Promise<PanoramaJob[]> {
    const all = await this.db.getAll("jobs");
    return all.filter((j): j is PanoramaJob => j.kind === "panorama" && j.status === "done" && j.accountEmail === accountEmail);
  }

  /** The account's most recently updated jobs. */
  async recent(accountEmail: string, limit: number): Promise<PixJob[]> {
    const out: PixJob[] = [];
    let cursor = await this.db.transaction("jobs").store.index("byUpdated").openCursor(null, "prev");
    while (cursor && out.length < limit) {
      if (cursor.value.accountEmail === accountEmail) out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  }
}
