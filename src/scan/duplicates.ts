/**
 * Duplicate photos, by what they look like and with a similarity the user chooses: copies at
 * another size or compression have different bytes, so they are not the same file to Google Photos.
 *
 * A perceptual hash finds candidates; a tiny pixel comparison drops hashes that match by accident;
 * the best copy of each group is chosen automatically. Limits measured on a real library: ADR-0008.
 */

import pLimit from "p-limit";
import type { AlbumRef, ItemDetails, ItemFileInfo, LibraryItem } from "../domain/types.js";
import { ErrorCode, PixError, type SerializedError } from "../shared/errors.js";
import type { ScanCache } from "./scan-cache.js";
import { ScanFailures, type DetectorStats, type ScanContext, type ScanDetector, type ScanFinding } from "./scan-detector.js";
import { TrashMover, type TrashGateway } from "./trash-mover.js";

/** What is kept of a photo to compare it: a 256-bit hash (hex) and 16 x 16 RGB pixels. */
export interface PhotoPrint {
  hash: string;
  tiny: Uint8Array;
}

export interface PhotoPrinter {
  print(item: LibraryItem): Promise<PhotoPrint>;
}

export class DuplicateSimilarity {
  static readonly MIN_PERCENT = 75;
  static readonly MAX_PERCENT = 100;
  static readonly DEFAULT_PERCENT = 95;
  /** Unrelated photos differ in half of the 256 bits. */
  private static readonly UNRELATED_DISTANCE = 128;
  /** 75%. The closest 0.05% of unrelated photos start at 50 bits. */
  static readonly MAX_DISTANCE = 32;
  /** Same picture, even 10% brighter or cropped by 3%, stayed below this. */
  static readonly MAX_PIXEL_DIFF = 20;
  /** Together these make 100%: the same picture once at the same size. */
  static readonly SAME_DISTANCE = 16;
  static readonly SAME_PIXEL_DIFF = 3;

  /** A percentage, or null when these two are not the same picture at any setting. */
  static score(distance: number, pixelDiff: number): number | null {
    if (distance > DuplicateSimilarity.MAX_DISTANCE || pixelDiff > DuplicateSimilarity.MAX_PIXEL_DIFF) return null;
    if (distance <= DuplicateSimilarity.SAME_DISTANCE && pixelDiff <= DuplicateSimilarity.SAME_PIXEL_DIFF) return 100;
    return Math.min(99, Math.round(100 * (1 - distance / DuplicateSimilarity.UNRELATED_DISTANCE)));
  }
}

export interface DuplicatePhoto {
  item: LibraryItem;
  sizeBytes: number | null;
}

/** `a` and `b` index DuplicateIndex.photos. */
export interface DuplicateLink {
  a: number;
  b: number;
  similarity: number;
}

/** One finding per scan: moving the slider regroups these without reading anything again. */
export interface DuplicateIndex extends ScanFinding {
  detector: "duplicates";
  photos: DuplicatePhoto[];
  links: DuplicateLink[];
}

export class PrintComparer {
  private static readonly WORDS = 8;
  /** Same shape: a copy keeps its proportions. */
  private static readonly MAX_ASPECT_DIFF = 0.02;
  private static readonly ROWS_PER_SLICE = 256;

  /** Every pair close enough at the loosest setting. Yields regularly so the page stays responsive. */
  static async links(items: readonly LibraryItem[], prints: readonly PhotoPrint[], signal: AbortSignal, onRow: (row: number) => void): Promise<{ a: number; b: number; similarity: number }[]> {
    // Paragraph: flat arrays, since this is the one loop that sees every pair.
    const n = items.length;
    const W = PrintComparer.WORDS;
    const hashes = new Uint32Array(n * W);
    const aspects = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      PrintComparer.fill(hashes, i * W, prints[i]!.hash);
      aspects[i] = items[i]!.width / items[i]!.height;
    }

    const links: { a: number; b: number; similarity: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (i % PrintComparer.ROWS_PER_SLICE === 0) {
        if (signal.aborted) throw new PixError(ErrorCode.Cancelled, "The scan was stopped");
        onRow(i);
        await new Promise((r) => setTimeout(r));
      }
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(aspects[i]! - aspects[j]!) > PrintComparer.MAX_ASPECT_DIFF) continue;
        let distance = 0;
        for (let w = 0; w < W; w++) distance += PrintComparer.bits(hashes[i * W + w]! ^ hashes[j * W + w]!);
        if (distance > DuplicateSimilarity.MAX_DISTANCE) continue;
        const similarity = DuplicateSimilarity.score(distance, PrintComparer.pixelDiff(prints[i]!.tiny, prints[j]!.tiny));
        if (similarity !== null) links.push({ a: i, b: j, similarity });
      }
    }
    return links;
  }

  /** Mean absolute difference per channel, 0 to 255. */
  static pixelDiff(a: Uint8Array, b: Uint8Array): number {
    if (a.length !== b.length || a.length === 0) throw new PixError(ErrorCode.Internal, "Photo prints of different sizes", { a: a.length, b: b.length });
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
    return sum / a.length;
  }

  private static fill(target: Uint32Array, at: number, hex: string): void {
    if (hex.length !== PrintComparer.WORDS * 8) throw new PixError(ErrorCode.Internal, "A photo hash has the wrong length", { length: hex.length });
    for (let w = 0; w < PrintComparer.WORDS; w++) target[at + w] = Number.parseInt(hex.slice(w * 8, w * 8 + 8), 16);
  }

  private static bits(value: number): number {
    let x = value;
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
}

export interface DuplicateMember {
  photo: DuplicatePhoto;
  /** To the group's best photo; 100 for the best photo itself. */
  similarity: number;
}

export interface DuplicateGroup {
  /** Best first. */
  members: DuplicateMember[];
  /** Why the first member is the best. */
  reason: string;
}

export class DuplicateGrouper {
  /** Yours first, then the most pixels, the largest file, a location, the oldest. */
  static compare(a: DuplicatePhoto, b: DuplicatePhoto): number {
    const owned = (p: DuplicatePhoto) => (p.item.editable === false ? 0 : 1);
    const pixels = (p: DuplicatePhoto) => p.item.width * p.item.height;
    const located = (p: DuplicatePhoto) => (p.item.location ? 1 : 0);
    return owned(b) - owned(a) || pixels(b) - pixels(a) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || located(b) - located(a) || a.item.takenAtMs - b.item.takenAtMs;
  }

  /**
   * Each group is its best photo and whatever is similar enough to that photo, so a chain of
   * "A looks like B, B looks like C" can never put A and C together.
   */
  static groups(index: Pick<DuplicateIndex, "photos" | "links">, minSimilarity: number, gone: ReadonlySet<string> = new Set()): DuplicateGroup[] {
    // Paragraph: who is close to whom, at this setting.
    const near = new Map<number, Map<number, number>>();
    const connect = (from: number, to: number, similarity: number) => {
      const row = near.get(from) ?? new Map<number, number>();
      row.set(to, similarity);
      near.set(from, row);
    };
    const present = (i: number) => !gone.has(index.photos[i]!.item.dedupKey);
    for (const l of index.links) {
      if (l.similarity >= minSimilarity && present(l.a) && present(l.b)) {
        connect(l.a, l.b, l.similarity);
        connect(l.b, l.a, l.similarity);
      }
    }

    // Paragraph: best photos take their matches first.
    const ranked = [...near.keys()].sort((x, y) => DuplicateGrouper.compare(index.photos[x]!, index.photos[y]!));
    const taken = new Set<number>();
    const groups: DuplicateGroup[] = [];
    for (const leader of ranked) {
      if (taken.has(leader)) continue;
      const others = [...near.get(leader)!.entries()].filter(([i]) => !taken.has(i));
      if (others.length === 0) continue;
      taken.add(leader);
      for (const [i] of others) taken.add(i);
      const members = others
        .map(([i, similarity]) => ({ photo: index.photos[i]!, similarity }))
        .sort((x, y) => DuplicateGrouper.compare(x.photo, y.photo));
      const best = index.photos[leader]!;
      groups.push({ members: [{ photo: best, similarity: 100 }, ...members], reason: DuplicateGrouper.reason(best, members.map((m) => m.photo)) });
    }

    // Paragraph: closest matches on top, then the newest.
    const closest = (g: DuplicateGroup) => Math.max(...g.members.slice(1).map((m) => m.similarity));
    return groups.sort((x, y) => closest(y) - closest(x) || y.members[0]!.photo.item.takenAtMs - x.members[0]!.photo.item.takenAtMs);
  }

  private static reason(best: DuplicatePhoto, others: readonly DuplicatePhoto[]): string {
    const pixels = (p: DuplicatePhoto) => p.item.width * p.item.height;
    if (others.some((o) => o.item.editable === false) && best.item.editable !== false) return "The one that is yours";
    if (others.every((o) => pixels(best) > pixels(o))) return `Highest resolution: ${best.item.width.toLocaleString()} × ${best.item.height.toLocaleString()}`;
    if (others.every((o) => (best.sizeBytes ?? 0) > (o.sizeBytes ?? 0))) return "Largest file";
    if (best.item.location && others.some((o) => !o.item.location)) return "Has a location";
    return "Oldest copy";
  }
}

/** What the user chose in one group. Without a choice, the best stays and the rest go. */
export type DuplicateChoices = Readonly<Record<string, "keep" | "trash">>;

export interface DuplicateTrashPlan {
  keep: LibraryItem;
  trash: LibraryItem[];
}

export class DuplicatePlans {
  static goes(group: DuplicateGroup, member: DuplicateMember, choices: DuplicateChoices): boolean {
    if (member.photo.item.editable === false) return false;
    return (choices[member.photo.item.dedupKey] ?? (member === group.members[0] ? "keep" : "trash")) === "trash";
  }

  /** Null when nothing goes, or nothing would stay: a group never loses its last photo. */
  static plan(group: DuplicateGroup, choices: DuplicateChoices): DuplicateTrashPlan | null {
    const goes = group.members.filter((m) => DuplicatePlans.goes(group, m, choices));
    const stays = group.members.filter((m) => !goes.includes(m));
    return goes.length === 0 || stays.length === 0 ? null : { keep: stays[0]!.photo.item, trash: goes.map((m) => m.photo.item) };
  }
}

export interface PhotoSizes {
  readItemInfo(mediaKeys: string[]): Promise<ItemFileInfo[]>;
}

export class DuplicatesDetector implements ScanDetector<DuplicateIndex> {
  /** Downloads at once. */
  static readonly PARALLEL = 8;
  static readonly SIZES_PER_REQUEST = 400;
  /** Bump when what is saved changes. */
  static readonly PRINT_VERSION = 1;

  readonly id = "duplicates" as const;
  readonly label = "Duplicates";
  readonly description = "Photos that look the same, at the similarity you choose.";

  constructor(
    private readonly printer: PhotoPrinter,
    private readonly sizes: PhotoSizes,
    private readonly cache: ScanCache<PhotoPrint>,
    private readonly recheck: boolean = false,
  ) {}

  async analyze(items: readonly LibraryItem[], ctx: ScanContext, emit: (finding: DuplicateIndex) => void): Promise<DetectorStats> {
    const stats: DetectorStats = { photosReused: 0, photosChecked: 0, failures: [] };
    const photos = items.filter((i) => i.type === "photo" && i.width > 0 && i.height > 0);

    // Paragraph: saved prints first; each new one is saved at once, so a stopped scan continues from there.
    const prints = new Map<string, PhotoPrint>();
    const missing: LibraryItem[] = [];
    for (const item of photos) {
      const saved = this.recheck ? null : await this.cache.get(DuplicatesDetector.key(item));
      if (saved) {
        prints.set(item.dedupKey, saved);
        stats.photosReused++;
      } else {
        missing.push(item);
      }
    }

    // Paragraph: the rest, a few at a time. A photo that cannot be read is counted and left out.
    const limit = pLimit(DuplicatesDetector.PARALLEL);
    let done = 0;
    let unreadable = 0;
    const stop: { error: PixError | null } = { error: null };
    await Promise.all(missing.map((item) => limit(async () => {
      if (stop.error) return;
      if (ctx.signal.aborted) {
        stop.error = new PixError(ErrorCode.Cancelled, "The scan was stopped");
        return;
      }
      ctx.progress("Reading photos", done, missing.length);
      try {
        const print = await this.printer.print(item);
        prints.set(item.dedupKey, print);
        await this.cache.put(DuplicatesDetector.key(item), print);
        stats.photosChecked++;
      } catch (err) {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.MediaFetchFailed, "Could not read a photo");
        if (ScanFailures.stopsTheScan(e)) stop.error ??= e;
        else unreadable++;
      }
      done++;
    })));
    if (stop.error) throw stop.error;
    if (unreadable > 0) stats.failures.push(new PixError(ErrorCode.MediaFetchFailed, `${unreadable} photo${unreadable === 1 ? "" : "s"} could not be read for duplicates`, { unreadable }).toJSON());

    // Paragraph: compare; only photos that matched something are kept.
    const known = photos.filter((p) => prints.has(p.dedupKey));
    const links = await PrintComparer.links(known, known.map((p) => prints.get(p.dedupKey)!), ctx.signal, (row) => ctx.progress("Comparing photos", row, known.length));
    const used = [...new Set(links.flatMap((l) => [l.a, l.b]))];
    const position = new Map(used.map((old, now) => [old, now]));
    const sizes = await this.readSizes(used.map((i) => known[i]!), ctx);
    emit({
      id: "duplicates:index",
      detector: "duplicates",
      mediaKeys: used.map((i) => known[i]!.mediaKey),
      photos: used.map((i) => ({ item: known[i]!, sizeBytes: sizes.get(known[i]!.mediaKey) ?? null })),
      links: links.map((l) => ({ a: position.get(l.a)!, b: position.get(l.b)!, similarity: l.similarity })),
    });
    return stats;
  }

  /** File sizes decide between copies with the same pixels, so a failed read must not stop the scan. */
  private async readSizes(items: readonly LibraryItem[], ctx: ScanContext): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    for (let i = 0; i < items.length; i += DuplicatesDetector.SIZES_PER_REQUEST) {
      ctx.progress("Reading file sizes", i, items.length);
      try {
        for (const info of await this.sizes.readItemInfo(items.slice(i, i + DuplicatesDetector.SIZES_PER_REQUEST).map((x) => x.mediaKey))) {
          if (info.sizeBytes !== undefined) sizes.set(info.mediaKey, info.sizeBytes);
        }
      } catch (err) {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not read file sizes");
        if (ScanFailures.stopsTheScan(e)) throw e;
        console.error("[pixlixir] file sizes unavailable, ranking without them", e);
      }
    }
    return sizes;
  }

  private static key(item: LibraryItem): string {
    return `v${DuplicatesDetector.PRINT_VERSION}|${item.dedupKey}`;
  }
}

export interface DuplicateGateway extends TrashGateway {
  getItemDetails(mediaKey: string): Promise<ItemDetails>;
  addToAlbum(mediaKeys: string[], album: AlbumRef): Promise<void>;
  setDescription(dedupKey: string, description: string): Promise<void>;
}

export interface DuplicateTrashResult {
  /** Groups left alone because a copy is in a shared album. */
  skippedShared: number;
  /** Groups left alone because what the kept photo must inherit could not be confirmed. */
  problems: SerializedError[];
}

/**
 * Moves the unwanted copies to trash. A copy leaves its albums with it, so first the kept photo
 * joins those albums and takes over a description, and that is read back. A group where this
 * cannot be done, or that touches a shared album, keeps all its photos.
 */
export class DuplicateTrasher {
  constructor(
    private readonly gateway: DuplicateGateway,
    private readonly mover: TrashMover = new TrashMover(gateway),
  ) {}

  /** `onMoved` gets the keys confirmed in the trash, before any failure is thrown. */
  async run(plans: readonly DuplicateTrashPlan[], onStep: (done: number, total: number) => void, onMoved: (keys: string[]) => Promise<void> | void): Promise<DuplicateTrashResult> {
    const result: DuplicateTrashResult = { skippedShared: 0, problems: [] };
    const ready: string[] = [];

    // Paragraph: get every kept photo ready first, so a problem costs one group and nothing is half done.
    for (const [n, plan] of plans.entries()) {
      onStep(n, plans.length);
      try {
        const shared = await this.prepare(plan);
        if (shared) result.skippedShared++;
        else ready.push(...plan.trash.map((i) => i.dedupKey));
      } catch (err) {
        const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.OriginalsKept, "Could not prepare a group of duplicates");
        if (ScanFailures.stopsTheScan(e)) throw e;
        result.problems.push(e.toJSON());
      }
    }

    // Paragraph: then the trash, confirmed batch by batch.
    await this.mover.run(ready, onMoved);
    return result;
  }

  /** True when a copy is in a shared album: adding to those is not verified, so the group stays as it is. */
  private async prepare(plan: DuplicateTrashPlan): Promise<boolean> {
    const copies: ItemDetails[] = [];
    for (const item of plan.trash) copies.push(await this.gateway.getItemDetails(item.mediaKey));
    if (copies.some((c) => c.albums.some((a) => a.shared))) return true;

    // Paragraph: albums the kept photo is not in yet, and a description it does not have.
    const before = await this.gateway.getItemDetails(plan.keep.mediaKey);
    const inAlbums = new Set(before.albums.map((a) => a.mediaKey));
    const missing = new Map(copies.flatMap((c) => c.albums).filter((a) => !inAlbums.has(a.mediaKey)).map((a) => [a.mediaKey, a]));
    for (const album of missing.values()) await this.gateway.addToAlbum([plan.keep.mediaKey], album);
    const description = before.description.trim().length > 0 ? "" : (copies.find((c) => c.description.trim().length > 0)?.description.trim() ?? "");
    if (description) await this.gateway.setDescription(plan.keep.dedupKey, description);

    // Paragraph: only what was read back counts.
    if (missing.size > 0 || description) {
      const after = await this.gateway.getItemDetails(plan.keep.mediaKey);
      const now = new Set(after.albums.map((a) => a.mediaKey));
      const lost = [...missing.keys()].filter((k) => !now.has(k)).length;
      if (lost > 0 || (description && after.description.trim() !== description)) {
        throw new PixError(ErrorCode.OriginalsKept, "The kept photo did not get the copies’ albums or description, so this group was left alone.", { lost });
      }
    }
    return false;
  }
}
