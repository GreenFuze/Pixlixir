/**
 * Creates panoramas for scan candidates, one at a time, with the same pipeline as the
 * Create-panorama editor: originals -> full-size stitch with inherited EXIF -> new item
 * dated like the earliest photo, with its location and description, in the same albums.
 */

import { DEFAULT_STITCH_SETTINGS, type StitchSettings } from "../../imaging/panorama/stitch-runtime.js";
import type { PanoramaCandidate } from "../../scan/panorama-detector.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import type { PanoramaWorkerClient } from "../editor/panorama/panorama-client.js";
import { MetadataInheritance, PanoramaPublisher, PanoramaSourceLoader, type LoadedSource, type PublishedPanorama } from "../editor/panorama/panorama-pipeline.js";
import type { PhotosGateway } from "../editor/photos-gateway.js";
import type { JobStore, PanoramaJob } from "../storage/job-store.js";

export interface BulkCreated {
  job: PanoramaJob;
  published: PublishedPanorama;
  width: number;
  height: number;
  /** Photos that could not be downloaded or decoded (left out of this panorama). */
  skipped: { mediaKey: string; error: SerializedError }[];
  warnings: string[];
}

export class PanoramaBulkCreator {
  /** Bulk saves use the editor's largest size. */
  static readonly MAX_MEGAPIXELS = 60;

  readonly #loader: PanoramaSourceLoader;
  readonly #publisher: PanoramaPublisher;

  constructor(
    private readonly gateway: PhotosGateway,
    private readonly worker: PanoramaWorkerClient,
    private readonly store: JobStore,
    private readonly nextKey: () => number,
    private readonly batchId: string,
    thumbnail: (blob: Blob) => Promise<Blob>,
  ) {
    this.#loader = new PanoramaSourceLoader(gateway, worker, thumbnail);
    this.#publisher = new PanoramaPublisher(gateway);
  }

  async create(candidate: PanoramaCandidate, step: (text: string) => void): Promise<BulkCreated> {
    const loaded: LoadedSource[] = [];
    const skipped: BulkCreated["skipped"] = [];
    try {
      // Paragraph: originals into the engine (photos that fail are left out and reported).
      const budget = PanoramaSourceLoader.budgetPerPhoto(candidate.items.length);
      for (const [i, item] of candidate.items.entries()) {
        step(`Downloading photo ${i + 1} of ${candidate.items.length}`);
        try {
          loaded.push(await this.#loader.load(this.nextKey(), item.mediaKey, budget));
        } catch (err) {
          const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.MediaFetchFailed, "Could not load a photo");
          if (e.code === ErrorCode.AccountMismatch || e.code === ErrorCode.TabNotBound || e.code === ErrorCode.SessionUnavailable) throw e;
          skipped.push({ mediaKey: item.mediaKey, error: e.toJSON() });
        }
      }
      if (loaded.length < 2) throw new PixError(ErrorCode.StitchNotConnected, "Fewer than two of these photos could be loaded.", { loaded: loaded.length });

      // Paragraph: what it inherits, then the full-size stitch with that EXIF.
      step("Reading date, location and albums");
      const inherited = await MetadataInheritance.collect(this.gateway, loaded.map((s) => ({ mediaKey: s.mediaKey, takenAtMs: s.item.takenAtMs, timezoneOffsetMs: s.item.timezoneOffsetMs })));
      const earliest = loaded.find((s) => s.mediaKey === inherited.earliestMediaKey) ?? null;
      const settings: StitchSettings = { ...DEFAULT_STITCH_SETTINGS, motion: candidate.preview?.motion ?? "rotate" };
      step("Building the full-size panorama");
      const render = await this.worker.stitch(loaded.map((s) => s.key), settings, {
        kind: "full",
        maxMegapixels: PanoramaBulkCreator.MAX_MEGAPIXELS,
        metadata: MetadataInheritance.outputMetadata(inherited, earliest?.head ?? null, true),
      });

      // Paragraph: save it where its photos are.
      step("Uploading to Google Photos");
      const used = loaded.filter((s) => render.used.includes(s.key));
      const fileName = PanoramaPublisher.outputName(used[0]?.item.fileName ?? null);
      const published = await this.#publisher.publish(render.image, fileName, inherited, { matchDate: true, albums: inherited.albums, copyDescription: true });

      // Paragraph: provenance record (shown in the side panel's recent work).
      const now = Date.now();
      const job = await this.store.put<PanoramaJob>({
        id: crypto.randomUUID(),
        kind: "panorama",
        accountEmail: this.gateway.email,
        sourceMediaKey: candidate.mediaKeys[0]!,
        sourceMediaKeys: candidate.mediaKeys,
        usedMediaKeys: used.map((s) => s.mediaKey),
        usedDedupKeys: used.map((s) => s.item.dedupKey),
        settings,
        status: "done",
        saved: { mediaKey: published.created.ref.mediaKey, webUrl: published.created.webUrl, fileName, width: render.width, height: render.height },
        error: null,
        batchId: this.batchId,
        inherited: {
          takenAtMs: inherited.takenAtMs,
          location: inherited.location !== null,
          description: published.descriptionSet,
          albums: published.albumsAdded.map((a) => a.title),
          problems: published.problems.map((p) => p.message),
        },
        createdAt: now,
        updatedAt: now,
      });
      return { job, published, width: render.width, height: render.height, skipped, warnings: render.warnings };
    } finally {
      // Paragraph: release the engine's copies.
      for (const s of loaded) await this.worker.remove(s.key).catch((e: unknown) => console.error("[pixlixir] could not free a photo", e));
    }
  }
}
