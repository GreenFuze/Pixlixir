/**
 * The Local API's operations (docs/api/openapi.yaml, ADR-0012). The helper passes each HTTP request
 * on as an operation name with its parameters as strings; everything is checked here, so the helper
 * holds no rules. Read-only: only reading operations exist.
 */

import { z } from "zod";
import type { AccountRef, AlbumRef, ItemDetails, ItemFileInfo, LibraryItem, MediaItemInfo, Page } from "../../domain/types.js";
import { API_VERSION, ApiError, ApiShapes, type ApiLibraryItem } from "./api-types.js";
import { FileNameFinder, SearchGate, type SearchSource } from "./file-name-finder.js";

/** A file to send in pieces; `size` is null when not known in advance. */
export interface FileBody {
  mimeType: string;
  size: number | null;
  chunks: AsyncIterable<Uint8Array>;
}

/** One account's library, as the API reads it. */
export interface ApiLibrary extends SearchSource {
  getItem(mediaKey: string): Promise<MediaItemInfo>;
  getItemDetails(mediaKey: string): Promise<ItemDetails>;
  readItemInfo(mediaKeys: string[]): Promise<ItemFileInfo[]>;
  listLibrary(page: string | null, startMs: number | null): Promise<Page<LibraryItem>>;
  listAlbums(page: string | null): Promise<Page<AlbumRef>>;
  listAlbumItems(albumKey: string, page: string | null): Promise<Page<LibraryItem>>;
  downloadOriginal(mediaKey: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** A video's original file, read by Pixlixir itself: Google serves it from a host the page cannot read. */
  downloadVideo(baseUrl: string): Promise<FileBody>;
  thumbnail(baseUrl: string, maxSide: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

/** The accounts open in Google Photos tabs, and each one's library. */
export interface AccountDirectory {
  accounts(): Promise<AccountRef[]>;
  library(account: AccountRef): ApiLibrary;
}

export type ApiResult = { kind: "json"; body: unknown } | ({ kind: "binary"; fileName: string } & FileBody);

/**
 * Where a filtered listing continues: Google's page and how many of its rows were already given.
 * Opaque to callers (base64url JSON).
 */
export class ListCursor {
  constructor(readonly page: string | null, readonly skip: number, readonly startMs: number | null) {}

  encode(): string {
    return btoa(JSON.stringify({ p: this.page, k: this.skip, s: this.startMs })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  static decode(token: string | undefined, startMs: number | null): ListCursor {
    if (token === undefined) return new ListCursor(null, 0, startMs);
    try {
      const v = JSON.parse(atob(token.replace(/-/g, "+").replace(/_/g, "/"))) as { p: unknown; k: unknown; s: unknown };
      if ((v.p === null || typeof v.p === "string") && Number.isInteger(v.k) && (v.k as number) >= 0 && (v.s === null || typeof v.s === "number")) return new ListCursor(v.p as string | null, v.k as number, v.s as number | null);
    } catch {
      // falls through to the error below
    }
    throw new ApiError("BAD_REQUEST", "Invalid pageToken: pass the nextPageToken of the previous page unchanged.");
  }
}

const Key = z.string().min(10).max(200).regex(/^[\w-]+$/, "a key has only letters, digits, - and _");
const Token = z.string().min(1).max(4096).optional();
const Account = z.string().email().optional();
const Time = z.string().datetime({ offset: true }).optional();
const MediaType = z.enum(["all", "photo", "video"]).optional().transform((v) => v ?? "all");
const Int = (min: number, max: number, fallback: number) => z.string().regex(/^\d+$/, "a whole number").transform(Number).pipe(z.number().int().min(min).max(max)).optional().transform((v) => v ?? fallback);

export const ApiRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status"), params: z.object({}).strict() }),
  z.object({ op: z.literal("items.find"), params: z.object({ fileName: z.string().trim().min(1).max(255), match: z.enum(["exact", "prefix", "contains"]).optional().transform((v) => v ?? "exact"), limit: Int(1, 500, 50), account: Account }).strict() }),
  z.object({ op: z.literal("search"), params: z.object({ query: z.string().trim().min(1).max(255), mediaType: MediaType, from: Time, to: Time, limit: Int(1, 100, 50), pageToken: Token, account: Account }).strict() }),
  z.object({ op: z.literal("items.get"), params: z.object({ mediaKey: Key, account: Account }).strict() }),
  z.object({ op: z.literal("items.original"), params: z.object({ mediaKey: Key, account: Account }).strict() }),
  z.object({ op: z.literal("items.thumbnail"), params: z.object({ mediaKey: Key, size: Int(64, 2048, 512), account: Account }).strict() }),
  z.object({ op: z.literal("library.list"), params: z.object({ before: Time, after: Time, mediaType: MediaType, limit: Int(1, 500, 100), pageToken: Token, account: Account }).strict() }),
  z.object({ op: z.literal("albums.list"), params: z.object({ pageToken: Token, account: Account }).strict() }),
  z.object({ op: z.literal("albums.items"), params: z.object({ albumKey: Key, pageToken: Token, account: Account }).strict() }),
]);
export type ApiRequest = z.infer<typeof ApiRequest>;

/** Which listed items to keep, and where a newest-first listing may stop. */
interface ListFilter {
  mediaType: "all" | "photo" | "video";
  fromMs: number | null;
  toMs: number | null;
}

export class LocalApiService {
  /** Google's pages read for one library request, at most. */
  static readonly LIBRARY_PAGES = 4;
  /** Google's search pages read for one search request, at most: each is a rationed search. */
  static readonly SEARCH_PAGES = 2;

  readonly #gates = new Map<string, SearchGate>();

  constructor(private readonly directory: AccountDirectory, private readonly versions: { pixlixir: string; helper: () => string | null }, private readonly newGate: () => SearchGate = () => new SearchGate()) {}

  /** Answers one request, or throws an ApiError. */
  async handle(raw: unknown): Promise<ApiResult> {
    // Paragraph: a request the API knows, with valid parameters.
    const parsed = ApiRequest.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError("BAD_REQUEST", "Invalid request: " + parsed.error.issues.slice(0, 3).map((i) => `${i.path.slice(1).join(".") || "op"}: ${i.message}`).join("; "), {});
    }
    const req = parsed.data;
    if (req.op === "status") {
      const accounts = await this.directory.accounts();
      return LocalApiService.json({ apiVersion: API_VERSION, pixlixirVersion: this.versions.pixlixir, helperVersion: this.versions.helper(), accounts: accounts.map((a) => a.email) });
    }

    // Paragraph: the account it is about, then the operation.
    const account = await this.account(req.params.account);
    const lib = this.directory.library(account);
    const lookup = req.op === "items.get" || req.op === "items.original" || req.op === "items.thumbnail" || req.op === "albums.items";
    try {
      return await this.run(req, account, lib);
    } catch (err) {
      throw ApiError.from(err, lookup);
    }
  }

  private async run(req: Exclude<ApiRequest, { op: "status" }>, account: AccountRef, lib: ApiLibrary): Promise<ApiResult> {
    switch (req.op) {
      case "items.find": {
        const { found, truncated } = await new FileNameFinder(this.gate(account.email)).find(lib, req.params.fileName, req.params.match, req.params.limit);
        return LocalApiService.json({ items: found.map((f) => ApiShapes.item(account, f.item, { fileName: f.info.fileName, sizeBytes: f.info.sizeBytes ?? null })), truncated });
      }
      case "search": {
        const filter = { mediaType: req.params.mediaType, fromMs: LocalApiService.time(req.params.from), toMs: LocalApiService.time(req.params.to) };
        const gate = this.gate(account.email);
        const query = req.params.query;
        const page = await this.collect(account, lib, (p) => gate.run(() => lib.search(query, p)), ListCursor.decode(req.params.pageToken, null), filter, req.params.limit, LocalApiService.SEARCH_PAGES, false);
        return LocalApiService.json(page);
      }
      case "items.get": {
        const [item, details] = await Promise.all([lib.getItem(req.params.mediaKey), lib.getItemDetails(req.params.mediaKey)]);
        return LocalApiService.json(ApiShapes.details(ApiShapes.item(account, { ...item, mediaKey: item.ref.mediaKey }, item), details));
      }
      case "items.original": {
        const item = await lib.getItem(req.params.mediaKey);
        const fileName = item.fileName ?? `${req.params.mediaKey}${item.type === "video" ? ".mp4" : ".jpg"}`;
        if (item.type === "video") return { kind: "binary", fileName, ...(await lib.downloadVideo(item.baseUrl)) };
        if (item.type !== "photo") throw new ApiError("NOT_SUPPORTED", "This kind of item cannot be downloaded.", { type: item.type });
        const file = await lib.downloadOriginal(req.params.mediaKey);
        return { kind: "binary", fileName, mimeType: file.mimeType, size: file.bytes.byteLength, chunks: LocalApiService.once(file.bytes) };
      }
      case "items.thumbnail": {
        const item = await lib.getItem(req.params.mediaKey);
        const file = await lib.thumbnail(item.baseUrl, req.params.size);
        return { kind: "binary", fileName: `${(item.fileName ?? req.params.mediaKey).replace(/\.[^.]+$/, "")}_${req.params.size}.jpg`, mimeType: file.mimeType, size: file.bytes.byteLength, chunks: LocalApiService.once(file.bytes) };
      }
      case "library.list": {
        // The listing is newest first, so `before` is where it starts and `after` where it stops.
        const filter = { mediaType: req.params.mediaType, fromMs: LocalApiService.time(req.params.after), toMs: null };
        const cursor = ListCursor.decode(req.params.pageToken, LocalApiService.time(req.params.before));
        const page = await this.collect(account, lib, (p) => lib.listLibrary(p, p === null ? cursor.startMs : null), cursor, filter, req.params.limit, LocalApiService.LIBRARY_PAGES, true);
        return LocalApiService.json(page);
      }
      case "albums.list": {
        const page = await lib.listAlbums(req.params.pageToken ?? null);
        return LocalApiService.json({ albums: page.items.map(ApiShapes.album), nextPageToken: page.next });
      }
      case "albums.items": {
        const page = await lib.listAlbumItems(req.params.albumKey, req.params.pageToken ?? null);
        return LocalApiService.json({ items: await this.withFiles(account, lib, page.items), nextPageToken: page.next });
      }
    }
  }

  /**
   * Reads Google's pages from the cursor, keeps the items that pass the filter, and stops at `limit`,
   * at the end, or after `maxPages`. `newestFirst` lets an item older than the filter end the listing.
   */
  private async collect(account: AccountRef, lib: ApiLibrary, fetchPage: (page: string | null) => Promise<Page<LibraryItem>>, cursor: ListCursor, filter: ListFilter, limit: number, maxPages: number, newestFirst: boolean): Promise<{ items: ApiLibraryItem[]; nextPageToken: string | null }> {
    const kept: LibraryItem[] = [];
    let page = cursor.page;
    let skip = cursor.skip;
    for (let n = 0; n < maxPages; n++) {
      // Paragraph: one of Google's pages, from where the last answer stopped.
      const got = await fetchPage(page);
      for (let i = skip; i < got.items.length; i++) {
        const item = got.items[i]!;
        if (newestFirst && filter.fromMs !== null && item.takenAtMs < filter.fromMs) return { items: await this.withFiles(account, lib, kept), nextPageToken: null };
        if (!LocalApiService.passes(item, filter)) continue;
        kept.push(item);
        if (kept.length === limit) {
          const more = i + 1 < got.items.length || got.next !== null;
          const next = i + 1 < got.items.length ? new ListCursor(page, i + 1, cursor.startMs) : new ListCursor(got.next, 0, cursor.startMs);
          return { items: await this.withFiles(account, lib, kept), nextPageToken: more ? next.encode() : null };
        }
      }

      // Paragraph: the next page, if there is one.
      if (got.next === null) return { items: await this.withFiles(account, lib, kept), nextPageToken: null };
      page = got.next;
      skip = 0;
    }
    return { items: await this.withFiles(account, lib, kept), nextPageToken: new ListCursor(page, 0, cursor.startMs).encode() };
  }

  private static passes(item: LibraryItem, f: ListFilter): boolean {
    if (f.mediaType !== "all" && item.type !== f.mediaType) return false;
    if (f.fromMs !== null && item.takenAtMs < f.fromMs) return false;
    if (f.toMs !== null && item.takenAtMs > f.toMs) return false;
    return true;
  }

  /** Listed items with their file names and sizes (one call for up to 500). */
  private async withFiles(account: AccountRef, lib: ApiLibrary, items: LibraryItem[]): Promise<ApiLibraryItem[]> {
    const info = new Map<string, ItemFileInfo>();
    for (let k = 0; k < items.length; k += 500) for (const i of await lib.readItemInfo(items.slice(k, k + 500).map((x) => x.mediaKey))) info.set(i.mediaKey, i);
    return items.map((i) => ApiShapes.libraryItem(account, i, { fileName: info.get(i.mediaKey)?.fileName ?? null, sizeBytes: info.get(i.mediaKey)?.sizeBytes ?? null }));
  }

  /** The named account, or the only one open. */
  private async account(email: string | undefined): Promise<AccountRef> {
    const accounts = await this.directory.accounts();
    if (accounts.length === 0) throw new ApiError("NO_PHOTOS_TAB", "No signed-in Google Photos tab is open. Open photos.google.com in Chrome.");
    if (email !== undefined) {
      const named = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
      if (!named) throw new ApiError("NO_PHOTOS_TAB", `No Google Photos tab is signed in as ${email}.`, { accounts: accounts.map((a) => a.email) });
      return named;
    }
    if (accounts.length > 1) throw new ApiError("ACCOUNT_REQUIRED", "Several accounts are open in Google Photos: say which with account=.", { accounts: accounts.map((a) => a.email) });
    return accounts[0]!;
  }

  private gate(email: string): SearchGate {
    let gate = this.#gates.get(email);
    if (!gate) this.#gates.set(email, (gate = this.newGate()));
    return gate;
  }

  private static time(v: string | undefined): number | null {
    return v === undefined ? null : Date.parse(v);
  }

  private static async *once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
    yield bytes;
  }

  private static json(body: unknown): ApiResult {
    return { kind: "json", body };
  }
}
