/**
 * The Local API's operations (docs/api/openapi.yaml, ADR-0012). The helper passes each HTTP request
 * on as an operation name with its parameters as strings; everything is checked here, so the helper
 * holds no rules. Read-only: only reading operations exist.
 */

import { z } from "zod";
import type { AccountRef, AlbumRef, ItemDetails, ItemFileInfo, LibraryItem, MediaItemInfo, Page } from "../../domain/types.js";
import { API_VERSION, ApiError, ApiShapes } from "./api-types.js";
import { FileNameFinder, SearchGate, type SearchSource } from "./file-name-finder.js";

/** One account's library, as the API reads it. */
export interface ApiLibrary extends SearchSource {
  getItem(mediaKey: string): Promise<MediaItemInfo>;
  getItemDetails(mediaKey: string): Promise<ItemDetails>;
  readItemInfo(mediaKeys: string[]): Promise<ItemFileInfo[]>;
  listLibrary(page: string | null, startMs: number | null): Promise<Page<LibraryItem>>;
  listAlbums(page: string | null): Promise<Page<AlbumRef>>;
  listAlbumItems(albumKey: string, page: string | null): Promise<Page<LibraryItem>>;
  downloadOriginal(mediaKey: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
  thumbnail(baseUrl: string, maxSide: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

/** The accounts open in Google Photos tabs, and each one's library. */
export interface AccountDirectory {
  accounts(): Promise<AccountRef[]>;
  library(account: AccountRef): ApiLibrary;
}

export type ApiResult = { kind: "json"; body: unknown } | { kind: "binary"; bytes: Uint8Array; mimeType: string; fileName: string };

const Key = z.string().min(10).max(200).regex(/^[\w-]+$/, "a key has only letters, digits, - and _");
const Token = z.string().min(1).max(4096).optional();
const Account = z.string().email().optional();
const Int = (min: number, max: number, fallback: number) => z.string().regex(/^\d+$/, "a whole number").transform(Number).pipe(z.number().int().min(min).max(max)).optional().transform((v) => v ?? fallback);

export const ApiRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status"), params: z.object({}).strict() }),
  z.object({ op: z.literal("items.find"), params: z.object({ fileName: z.string().trim().min(1).max(255), match: z.enum(["exact", "prefix", "contains"]).optional().transform((v) => v ?? "exact"), limit: Int(1, 500, 50), account: Account }).strict() }),
  z.object({ op: z.literal("items.get"), params: z.object({ mediaKey: Key, account: Account }).strict() }),
  z.object({ op: z.literal("items.original"), params: z.object({ mediaKey: Key, account: Account }).strict() }),
  z.object({ op: z.literal("items.thumbnail"), params: z.object({ mediaKey: Key, size: Int(64, 2048, 512), account: Account }).strict() }),
  z.object({ op: z.literal("library.list"), params: z.object({ before: z.string().datetime({ offset: true }).optional(), pageToken: Token, account: Account }).strict() }),
  z.object({ op: z.literal("albums.list"), params: z.object({ pageToken: Token, account: Account }).strict() }),
  z.object({ op: z.literal("albums.items"), params: z.object({ albumKey: Key, pageToken: Token, account: Account }).strict() }),
]);
export type ApiRequest = z.infer<typeof ApiRequest>;

export class LocalApiService {
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
    const lookup = req.op !== "items.find" && req.op !== "library.list" && req.op !== "albums.list";
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
      case "items.get": {
        const [item, details] = await Promise.all([lib.getItem(req.params.mediaKey), lib.getItemDetails(req.params.mediaKey)]);
        return LocalApiService.json(ApiShapes.details(ApiShapes.item(account, { ...item, mediaKey: item.ref.mediaKey }, item), details));
      }
      case "items.original": {
        const item = await lib.getItem(req.params.mediaKey);
        if (item.type !== "photo") throw new ApiError("NOT_SUPPORTED", "Only photos can be downloaded as originals for now.", { type: item.type });
        const file = await lib.downloadOriginal(req.params.mediaKey);
        return { kind: "binary", bytes: file.bytes, mimeType: file.mimeType, fileName: item.fileName ?? `${req.params.mediaKey}.jpg` };
      }
      case "items.thumbnail": {
        const item = await lib.getItem(req.params.mediaKey);
        const file = await lib.thumbnail(item.baseUrl, req.params.size);
        return { kind: "binary", bytes: file.bytes, mimeType: file.mimeType, fileName: `${(item.fileName ?? req.params.mediaKey).replace(/\.[^.]+$/, "")}_${req.params.size}.jpg` };
      }
      case "library.list": {
        const startMs = req.params.pageToken === undefined && req.params.before !== undefined ? Date.parse(req.params.before) : null;
        const page = await lib.listLibrary(req.params.pageToken ?? null, startMs);
        return LocalApiService.json({ items: page.items.map((i) => ApiShapes.libraryItem(account, i)), nextPageToken: page.next });
      }
      case "albums.list": {
        const page = await lib.listAlbums(req.params.pageToken ?? null);
        return LocalApiService.json({ albums: page.items.map(ApiShapes.album), nextPageToken: page.next });
      }
      case "albums.items": {
        const page = await lib.listAlbumItems(req.params.albumKey, req.params.pageToken ?? null);
        return LocalApiService.json({ items: page.items.map((i) => ApiShapes.libraryItem(account, i)), nextPageToken: page.next });
      }
    }
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

  private static json(body: unknown): ApiResult {
    return { kind: "json", body };
  }
}
