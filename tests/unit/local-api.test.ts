import { describe, expect, it } from "vitest";
import type { AccountRef, MediaItemInfo } from "../../src/domain/types.js";
import { LocalApiService, type AccountDirectory, type ApiLibrary } from "../../src/extension/api/api-service.js";
import { ApiError, ApiShapes } from "../../src/extension/api/api-types.js";
import { FileNameMatcher, SearchGate } from "../../src/extension/api/file-name-finder.js";
import { MockPhotosAdapter } from "../../src/gphotos/mock-adapter.js";
import { ErrorCode, PixError } from "../../src/shared/errors.js";

const ME: AccountRef = { email: "me@example.com", gaiaId: null, authUserIndex: 1 };
const T = Date.UTC(2019, 6, 14, 6, 3, 0);
const photo = (n: number, fileName: string, over: Partial<MediaItemInfo> = {}): MediaItemInfo => ({ ref: { accountEmail: ME.email, mediaKey: `AF1QipKEY${n}0000000` }, dedupKey: `dedup${n}`, type: "photo", width: 4000, height: 3000, takenAtMs: T + n * 60_000, timezoneOffsetMs: 3 * 3_600_000, baseUrl: `https://lh3.googleusercontent.com/k${n}`, fileName, sizeBytes: 1000 + n, ...over });

/** The stand-in library as the API sees one account. */
function libraryOf(mock: MockPhotosAdapter): ApiLibrary {
  return {
    search: (q, p) => mock.search(q, p), readItemInfo: (k) => mock.readItemInfo(k), getItem: (k) => mock.getItem(k), getItemDetails: (k) => mock.getItemDetails(k),
    listLibrary: (p, s) => mock.listLibrary({ page: p, startMs: s }), listAlbums: (p) => mock.listAlbums(p), listAlbumItems: (a, p) => mock.listAlbumItems(a, p),
    downloadOriginal: (k) => mock.downloadOriginal(k), thumbnail: (u, s) => mock.fetchThumbnail(u, s),
  };
}

function setup(accounts: AccountRef[] = [ME]) {
  const mock = new MockPhotosAdapter(ME);
  mock.addItem(photo(1, "IMG_1234.jpg"));
  mock.addItem(photo(2, "IMG_1234.HEIC"));
  mock.addItem(photo(3, "IMG_12345.jpg"));
  mock.addItem(photo(4, "holiday IMG_1234 copy.jpg"));
  mock.addItem(photo(5, "clip.mp4", { type: "video" }));
  mock.originals.set("AF1QipKEY10000000", new Uint8Array([0xff, 0xd8, 1, 2]));
  mock.details.set("AF1QipKEY10000000", { description: "Beach", albums: [{ mediaKey: "AF1QipALBUM0000000", title: "Summer", shared: false }], location: { latitude: 32.1, longitude: 34.8 }, camera: { make: "Canon", model: "EOS" } });
  const directory: AccountDirectory = { accounts: async () => accounts, library: () => libraryOf(mock) };
  const noWait = () => new SearchGate(Date.now, async () => {});
  return { mock, api: new LocalApiService(directory, { pixlixir: "0.3.0", helper: () => "0.3.0" }, noWait) };
}

const body = async (p: Promise<{ kind: string; body?: unknown }>) => ((await p) as { body: Record<string, unknown> }).body;

describe("Local API", () => {
  it("finds by exact name ignoring case, with or without the extension, and checks the real name", async () => {
    const { api } = setup();
    const exact = await body(api.handle({ op: "items.find", params: { fileName: "img_1234.JPG" } }));
    expect((exact.items as { fileName: string }[]).map((i) => i.fileName)).toEqual(["IMG_1234.jpg"]);
    const stem = await body(api.handle({ op: "items.find", params: { fileName: "IMG_1234" } }));
    expect((stem.items as { fileName: string }[]).map((i) => i.fileName)).toEqual(["IMG_1234.HEIC", "IMG_1234.jpg"]);
    const prefix = await body(api.handle({ op: "items.find", params: { fileName: "IMG_1234", match: "prefix", limit: "2" } }));
    expect(prefix).toMatchObject({ truncated: true });
    expect(prefix.items).toHaveLength(2);
  });

  it("gives an item's details with its local time and web address", async () => {
    const { api } = setup();
    const item = await body(api.handle({ op: "items.get", params: { mediaKey: "AF1QipKEY10000000" } }));
    expect(item).toMatchObject({ fileName: "IMG_1234.jpg", takenAt: "2019-07-14T09:04:00+03:00", timezoneOffsetMinutes: 180, sizeBytes: 1001, description: "Beach", albums: [{ albumKey: "AF1QipALBUM0000000", title: "Summer", shared: false }], camera: { make: "Canon", model: "EOS" }, webUrl: "https://photos.google.com/u/1/photo/AF1QipKEY10000000" });
  });

  it("downloads an original with its name, and refuses a video", async () => {
    const { api } = setup();
    expect(await api.handle({ op: "items.original", params: { mediaKey: "AF1QipKEY10000000" } })).toMatchObject({ kind: "binary", mimeType: "image/jpeg", fileName: "IMG_1234.jpg" });
    await expect(api.handle({ op: "items.original", params: { mediaKey: "AF1QipKEY50000000" } })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("pages the library and albums", async () => {
    const { api } = setup();
    const first = await body(api.handle({ op: "library.list", params: {} }));
    expect(first.items).toHaveLength(3);
    const second = await body(api.handle({ op: "library.list", params: { pageToken: first.nextPageToken as string } }));
    expect(second.items).toHaveLength(2);
    expect(second.nextPageToken).toBeNull();
    const before = await body(api.handle({ op: "library.list", params: { before: "2019-07-14T09:04:30+03:00" } }));
    expect((before.items as { mediaKey: string }[]).map((i) => i.mediaKey)).toEqual(["AF1QipKEY10000000"]);
  });

  it("refuses bad requests, unknown items and unclear accounts with stable codes", async () => {
    const { api } = setup();
    await expect(api.handle({ op: "items.find", params: {} })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.handle({ op: "items.find", params: { fileName: "x", limit: "9999" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.handle({ op: "items.delete", params: {} })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(api.handle({ op: "items.get", params: { mediaKey: "AF1QipNOSUCH0000" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const two = setup([ME, { email: "other@example.com", gaiaId: null, authUserIndex: 0 }]).api;
    await expect(two.handle({ op: "items.get", params: { mediaKey: "AF1QipKEY10000000" } })).rejects.toMatchObject({ code: "ACCOUNT_REQUIRED", details: { accounts: ["me@example.com", "other@example.com"] } });
    expect(await body(two.handle({ op: "items.get", params: { mediaKey: "AF1QipKEY10000000", account: "ME@example.com" } }))).toMatchObject({ fileName: "IMG_1234.jpg" });
    await expect(setup([]).api.handle({ op: "albums.list", params: {} })).rejects.toMatchObject({ code: "NO_PHOTOS_TAB" });
    expect(await body(setup([]).api.handle({ op: "status", params: {} }))).toMatchObject({ apiVersion: "1.0.0", accounts: [] });
  });
});

describe("SearchGate", () => {
  it("spaces searches out, and after Google refuses holds every search back with a retry time", async () => {
    let now = 1_000_000;
    const waits: number[] = [];
    const gate = new SearchGate(() => now, async (ms) => { waits.push(ms); now += ms; });
    await gate.run(async () => 1);
    await gate.run(async () => 2);
    expect(waits).toEqual([SearchGate.MIN_INTERVAL_MS]);
    await expect(gate.run(async () => { throw new PixError(ErrorCode.RateLimited, "no"); })).rejects.toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSeconds: SearchGate.COOLDOWN_MS / 1000 } });
    let asked = false;
    now += 60_000;
    await expect(gate.run(async () => { asked = true; return 3; })).rejects.toBeInstanceOf(ApiError);
    expect(asked).toBe(false);
    now += SearchGate.COOLDOWN_MS;
    expect(await gate.run(async () => 4)).toBe(4);
  });
});

describe("FileNameMatcher and ApiShapes", () => {
  it("matches the way the API promises", () => {
    expect(new FileNameMatcher("IMG_1.JPG", "exact").matches("img_1.jpg")).toBe(true);
    expect(new FileNameMatcher("IMG_1", "exact").matches("IMG_1.png")).toBe(true);
    expect(new FileNameMatcher("IMG_1", "exact").matches("IMG_10.png")).toBe(false);
    expect(new FileNameMatcher("1.j", "contains").matches("IMG_1.jpg")).toBe(true);
    expect(new FileNameMatcher("IMG", "prefix").matches(null)).toBe(false);
  });

  it("writes local times with their offset, west and east", () => {
    expect(ApiShapes.localTime(Date.UTC(2020, 0, 1, 2, 0), -5 * 3_600_000)).toBe("2019-12-31T21:00:00-05:00");
    expect(ApiShapes.localTime(Date.UTC(2020, 0, 1, 2, 0), 5.5 * 3_600_000)).toBe("2020-01-01T07:30:00+05:30");
  });
});
