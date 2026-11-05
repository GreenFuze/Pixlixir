/** Moves the photos in a saved panorama to trash, once the panorama is confirmed in the library. */

import { TrashMover } from "../../../scan/trash-mover.js";
import { ErrorCode, PixError } from "../../../shared/errors.js";
import type { JobStore, PanoramaJob } from "../../storage/job-store.js";
import type { PhotosGateway } from "../photos-gateway.js";

export interface OriginalsResult {
  job: PanoramaJob;
  /** Null when every photo reached the trash. */
  error: PixError | null;
}

type OriginalsGateway = Pick<PhotosGateway, "getItem" | "moveToTrash" | "listTrash">;
type OriginalsStore = Pick<JobStore, "put">;

export class PanoramaOriginals {
  constructor(
    private readonly gateway: OriginalsGateway,
    private readonly store: OriginalsStore,
    private readonly mover: TrashMover = new TrashMover(gateway),
  ) {}

  /** Never throws for a failed move: what happened is on the returned job, and in `error`. */
  async trash(source: PanoramaJob, dedupKeys: readonly string[], onMoved?: (moved: number) => void): Promise<OriginalsResult> {
    let job = source;
    const moved = new Set<string>(source.originalsTrash?.moved ?? []);
    const remaining = dedupKeys.filter((k) => !moved.has(k));
    const all = [...new Set([...(source.originalsTrash?.dedupKeys ?? []), ...dedupKeys])];
    const record = (state: "moving" | "moved" | "failed") => ({ dedupKeys: all, moved: [...moved], state });
    try {
      // Paragraph: the panorama must really be there before its photos go.
      await this.confirmSaved(job);

      // Paragraph: the record comes before the first move.
      job = await this.store.put<PanoramaJob>({ ...job, originalsTrash: record("moving") });
      await this.mover.run(remaining, async (keys) => {
        for (const k of keys) moved.add(k);
        job = await this.store.put<PanoramaJob>({ ...job, originalsTrash: record("moving") });
        onMoved?.(moved.size);
      });
      job = await this.store.put<PanoramaJob>({ ...job, originalsTrash: record("moved") });
      return { job, error: null };
    } catch (err) {
      const error = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not move the photos to trash");
      if (job.originalsTrash) job = await this.store.put<PanoramaJob>({ ...job, originalsTrash: record("failed") });
      return { job, error };
    }
  }

  private async confirmSaved(job: PanoramaJob): Promise<void> {
    if (!job.saved) throw new PixError(ErrorCode.OriginalsKept, "This panorama was not saved, so its photos were not moved.");
    try {
      await this.gateway.getItem(job.saved.mediaKey);
    } catch (err) {
      const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not read the panorama");
      if (e.code === ErrorCode.AccountMismatch || e.code === ErrorCode.TabNotBound || e.code === ErrorCode.SessionUnavailable) throw e;
      throw new PixError(ErrorCode.OriginalsKept, "Could not find the panorama in your library, so its photos were not moved. Try again in a moment.", { cause: e.toJSON() });
    }
  }
}
