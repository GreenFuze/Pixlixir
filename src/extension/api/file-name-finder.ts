/**
 * Finding items by file name (ADR-0012). Google's search is broad (a file name also matches dates and
 * other photos), so each result's real file name is read and compared. Google refuses searches for
 * minutes after about 20 in 25 s, so searches pass through a gate that spaces them out and, once
 * refused, answers "try later" without asking Google again until the pause is over.
 */

import type { ItemFileInfo, LibraryItem, Page } from "../../domain/types.js";
import { ErrorCode, PixError } from "../../shared/errors.js";
import { ApiError } from "./api-types.js";

export type NameMatch = "exact" | "prefix" | "contains";

export class FileNameMatcher {
  private readonly want: string;
  private readonly hasExtension: boolean;

  constructor(fileName: string, private readonly mode: NameMatch) {
    this.want = fileName.trim().toLowerCase();
    this.hasExtension = /\.[a-z0-9]{1,6}$/.test(this.want);
  }

  /** Exact ignores case, and without an extension in the query, the name's extension. */
  matches(fileName: string | null): boolean {
    if (!fileName) return false;
    const name = fileName.toLowerCase();
    if (this.mode === "prefix") return name.startsWith(this.want);
    if (this.mode === "contains") return name.includes(this.want);
    return this.hasExtension ? name === this.want : name.replace(/\.[^.]+$/, "") === this.want;
  }
}

/** Spaces searches out per account, and holds them all back for a while after Google refuses. */
export class SearchGate {
  /** At least this long between two searches. */
  static readonly MIN_INTERVAL_MS = 3_000;
  /** After a refusal, no search is sent for this long. */
  static readonly COOLDOWN_MS = 5 * 60_000;

  #next = 0;
  #blockedUntil = 0;

  constructor(private readonly now: () => number = Date.now, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  /** Runs one search when its turn comes. A refusal starts the pause and is passed on as RATE_LIMITED. */
  async run<T>(search: () => Promise<T>): Promise<T> {
    // Paragraph: still paused after a refusal.
    this.throwIfBlocked();

    // Paragraph: wait for this search's turn; turns are handed out in order.
    const at = Math.max(this.now(), this.#next);
    this.#next = at + SearchGate.MIN_INTERVAL_MS;
    if (at > this.now()) await this.sleep(at - this.now());
    this.throwIfBlocked();

    // Paragraph: Google's refusal pauses every search.
    try {
      return await search();
    } catch (err) {
      if (err instanceof PixError && err.code === ErrorCode.RateLimited) {
        this.#blockedUntil = this.now() + SearchGate.COOLDOWN_MS;
        this.throwIfBlocked();
      }
      throw err;
    }
  }

  private throwIfBlocked(): void {
    const wait = this.#blockedUntil - this.now();
    if (wait > 0) throw new ApiError("RATE_LIMITED", "Google Photos is refusing searches for now. Try again later.", { retryAfterSeconds: Math.ceil(wait / 1000) });
  }
}

/** What finding needs from one account's library. */
export interface SearchSource {
  search(query: string, page: string | null): Promise<Page<LibraryItem>>;
  readItemInfo(mediaKeys: string[]): Promise<ItemFileInfo[]>;
}

export interface FoundItem {
  item: LibraryItem;
  info: ItemFileInfo;
}

export class FileNameFinder {
  /** Google's pages read for one request, at most. */
  static readonly MAX_PAGES = 3;
  /** Google's details call takes this many keys at once. */
  private static readonly INFO_BATCH = 500;

  constructor(private readonly gate: SearchGate) {}

  async find(source: SearchSource, fileName: string, mode: NameMatch, limit: number): Promise<{ found: FoundItem[]; truncated: boolean }> {
    const matcher = new FileNameMatcher(fileName, mode);
    const found: FoundItem[] = [];
    const seen = new Set<string>();
    let page: string | null = null;

    for (let n = 0; n < FileNameFinder.MAX_PAGES; n++) {
      // Paragraph: one page of Google's results, through the gate.
      const current: string | null = page;
      const result: Page<LibraryItem> = await this.gate.run(() => source.search(fileName.trim(), current));
      const fresh = result.items.filter((i) => !seen.has(i.mediaKey));
      for (const i of fresh) seen.add(i.mediaKey);

      // Paragraph: their real file names, and keep the ones that match.
      for (let k = 0; k < fresh.length; k += FileNameFinder.INFO_BATCH) {
        const batch = fresh.slice(k, k + FileNameFinder.INFO_BATCH);
        const info = new Map((await source.readItemInfo(batch.map((i) => i.mediaKey))).map((i) => [i.mediaKey, i]));
        for (const item of batch) {
          const i = info.get(item.mediaKey);
          if (i && matcher.matches(i.fileName)) found.push({ item, info: i });
        }
      }

      // Paragraph: enough found, or nothing more to read.
      if (found.length > limit || result.next === null) return { found: FileNameFinder.newestFirst(found).slice(0, limit), truncated: found.length > limit };
      page = result.next;
    }
    return { found: FileNameFinder.newestFirst(found).slice(0, limit), truncated: found.length > limit };
  }

  private static newestFirst(found: FoundItem[]): FoundItem[] {
    return [...found].sort((a, b) => b.item.takenAtMs - a.item.takenAtMs);
  }
}
