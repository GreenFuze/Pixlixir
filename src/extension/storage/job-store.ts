/**
 * Persistent job records (IndexedDB). Jobs survive editor reloads and
 * service-worker restarts; saved outputs are recorded per print so a retry
 * never uploads the same print twice.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { AdjustmentPresets, type Adjustments } from "../../imaging/enhance/adjustments.js";
import type { Quad } from "../../imaging/geometry.js";
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

interface PixDb extends DBSchema {
  jobs: { key: string; value: SplitJob; indexes: { bySource: [string, string]; byUpdated: number } };
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

  async put(job: SplitJob): Promise<SplitJob> {
    const stored = { ...job, updatedAt: Date.now() };
    await this.db.put("jobs", stored);
    return stored;
  }

  async get(id: string): Promise<SplitJob> {
    const job = await this.db.get("jobs", id);
    if (!job) throw new PixError(ErrorCode.JobNotFound, `Job ${id} not found`, { id });
    return JobStore.upgrade(job);
  }

  /** Jobs written by v0.1 have no per-photo adjustments: give them the auto defaults. */
  static upgrade(job: SplitJob): SplitJob {
    return { ...job, prints: job.prints.map((p) => ((p as Partial<SplitPrintRecord>).adjustments ? p : { ...p, adjustments: AdjustmentPresets.auto() })) };
  }

  /** Most recent unfinished job for a source item, so the editor can resume it. */
  async latestOpenForSource(accountEmail: string, mediaKey: string): Promise<SplitJob | null> {
    const all = await this.db.getAllFromIndex("jobs", "bySource", [accountEmail, mediaKey]);
    const open = all.filter((j) => j.status !== "done").sort((a, b) => b.updatedAt - a.updatedAt);
    return open[0] ? JobStore.upgrade(open[0]) : null;
  }

  async recent(limit: number): Promise<SplitJob[]> {
    const out: SplitJob[] = [];
    let cursor = await this.db.transaction("jobs").store.index("byUpdated").openCursor(null, "prev");
    while (cursor && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  }
}
