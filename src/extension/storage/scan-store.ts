/**
 * Persistent scan results (IndexedDB), per account and detector. Kept apart from job records:
 * this is a cache of derived data that can always be rebuilt by scanning again.
 * Stays on this computer; nothing here is uploaded.
 *
 * RAII: ScanStore.open() acquires the database, close() releases it.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { DetectorId } from "../../scan/scan-detector.js";
import type { ScanCache } from "../../scan/scan-cache.js";
import { ErrorCode, PixError } from "../../shared/errors.js";

interface ScanDb extends DBSchema {
  sequences: { key: [string, string, string]; value: { account: string; detector: string; signature: string; value: unknown; savedAt: number } };
}

export class ScanStore {
  static readonly DB_NAME = "pixlixir-scan";
  static readonly VERSION = 1;

  private constructor(private readonly db: IDBPDatabase<ScanDb>) {}

  static async open(): Promise<ScanStore> {
    try {
      const db = await openDB<ScanDb>(ScanStore.DB_NAME, ScanStore.VERSION, {
        upgrade(d) {
          d.createObjectStore("sequences", { keyPath: ["account", "detector", "signature"] });
        },
      });
      return new ScanStore(db);
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.StorageFailed, "Could not open saved scan results");
    }
  }

  close(): void {
    this.db.close();
  }

  cache<T>(account: string, detector: DetectorId): ScanCache<T> {
    return {
      get: async (signature) => {
        try {
          const row = await this.db.get("sequences", [account, detector, signature]);
          return row ? (row.value as T) : null;
        } catch (err) {
          throw PixError.wrap(err, ErrorCode.StorageFailed, "Could not read saved scan results");
        }
      },
      put: async (signature, value) => {
        try {
          await this.db.put("sequences", { account, detector, signature, value, savedAt: Date.now() });
        } catch (err) {
          throw PixError.wrap(err, ErrorCode.StorageFailed, "Could not save scan results");
        }
      },
    };
  }
}
