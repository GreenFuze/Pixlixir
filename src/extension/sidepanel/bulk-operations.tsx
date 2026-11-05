/** Bulk operations: where a scan looks and what for, right in the panel. Scan opens the results modal. */

import { useEffect, useMemo, useState } from "preact/hooks";
import type { AlbumRef } from "../../domain/types.js";
import type { DetectorId } from "../../scan/scan-detector.js";
import { ScanPlans } from "../../scan/scan-plan.js";
import { ScanScopes, type ScanScope, type ScanScopeKind } from "../../scan/scan-scope.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { ErrorBox, Segmented } from "../editor/editor-ui.js";
import { PhotosGateway } from "../editor/photos-gateway.js";
import { Messenger, type TabActivity } from "../messaging/protocol.js";

interface Props {
  tabId: number;
  email: string;
  /** Items selected in Photos. */
  selection: string[];
  /** The album open in Photos. */
  albumKey: string | null;
  activity: TabActivity | null;
}

const failure = (err: unknown): SerializedError => (err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Bulk operations failed")).toJSON();

export function BulkOperations(props: Props) {
  const { tabId, email, selection, albumKey, activity } = props;
  const gateway = useMemo(() => new PhotosGateway(email, tabId), [email, tabId]);
  const now = new Date();

  // Paragraph: the form. Until a scope is chosen by hand, it follows what is open in Photos.
  const [chosenKind, setChosenKind] = useState<ScanScopeKind | null>(null);
  const [from, setFrom] = useState(ScanPlans.isoDate(new Date(now.getTime() - 30 * 86_400_000)));
  const [to, setTo] = useState(ScanPlans.isoDate(now));
  const [chosenAlbum, setChosenAlbum] = useState<string | null>(null);
  const [albums, setAlbums] = useState<AlbumRef[] | null>(null);
  const [detectors, setDetectors] = useState<Record<DetectorId, boolean>>({ panorama: true, dates: true, duplicates: true });
  const [recheck, setRecheck] = useState(false);
  const [error, setError] = useState<SerializedError | null>(null);
  const followed: ScanScopeKind = selection.length > 0 ? "selection" : albumKey ? "album" : "dateRange";
  const wanted = chosenKind ?? followed;
  const kind: ScanScopeKind = wanted === "selection" && selection.length === 0 ? followed : wanted;
  const album = chosenAlbum ?? albumKey;

  // Paragraph: albums load the first time they are needed.
  useEffect(() => {
    if (kind !== "album" || albums) return;
    gateway.allAlbums().then(setAlbums, (err: unknown) => setError(failure(err)));
  }, [kind, albums, gateway]);

  const presets = [
    { label: "30 days", from: new Date(now.getTime() - 30 * 86_400_000), to: now },
    { label: "12 months", from: new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()), to: now },
    { label: "This year", from: new Date(now.getFullYear(), 0, 1), to: now },
    { label: "Last year", from: new Date(now.getFullYear() - 1, 0, 1), to: new Date(now.getFullYear() - 1, 11, 31) },
  ];
  const scopes: { value: ScanScopeKind; label: string }[] = [
    { value: "dateRange", label: "Dates" },
    { value: "album", label: "Album" },
    ...(selection.length > 0 ? [{ value: "selection" as const, label: `Selected (${selection.length})` }] : []),
    { value: "library", label: "Whole library" },
  ];

  const scope = (): ScanScope => {
    switch (kind) {
      case "library":
        return { kind };
      case "selection":
        return { kind, mediaKeys: selection };
      case "dateRange":
        return ScanPlans.dateRange(from, to);
      case "album": {
        const found = albums?.find((a) => a.mediaKey === album);
        if (found) return { kind, album: found };
        // The album open in Photos may not be listed (e.g. shared with you by someone else).
        if (album && album === albumKey) return { kind, album: { mediaKey: album, title: "The album open in Google Photos", shared: false } };
        throw new PixError(ErrorCode.InvalidMessage, "Choose an album to scan.");
      }
    }
  };

  const start = async () => {
    setError(null);
    try {
      if (!detectors.panorama && !detectors.dates && !detectors.duplicates) throw new PixError(ErrorCode.InvalidMessage, "Choose at least one thing to look for.");
      await Messenger.toBackground({ type: "panel.openScan", tabId, plan: { scope: ScanScopes.validate(scope()), detectors, recheck } });
    } catch (err) {
      setError(failure(err));
    }
  };
  const run = (work: () => Promise<unknown>) => () => void work().catch((err: unknown) => setError(failure(err)));
  const toggle = (id: DetectorId) => setDetectors({ ...detectors, [id]: !detectors[id] });

  return (
    <section class="card bulk">
      <div class="label">Bulk operations</div>
      <Segmented<ScanScopeKind> label="Look through" value={kind} disabled={false} options={scopes} onChange={setChosenKind} />

      {kind === "dateRange" && (
        <>
          <div class="dates-row">
            <input type="date" aria-label="From" value={from} max={to} onChange={(e) => setFrom((e.target as HTMLInputElement).value)} />
            <span class="muted">–</span>
            <input type="date" aria-label="To" value={to} min={from} onChange={(e) => setTo((e.target as HTMLInputElement).value)} />
          </div>
          <div class="row">{presets.map((p) => <button key={p.label} class="btn small" onClick={() => { setFrom(ScanPlans.isoDate(p.from)); setTo(ScanPlans.isoDate(p.to)); }}>{p.label}</button>)}</div>
        </>
      )}
      {kind === "album" && (
        albums === null && !error ? <div class="muted small">Loading albums…</div> : (
          <select aria-label="Album" value={album ?? ""} onChange={(e) => setChosenAlbum((e.target as HTMLSelectElement).value)}>
            <option value="" disabled>Choose an album…</option>
            {albumKey && !albums?.some((a) => a.mediaKey === albumKey) && <option value={albumKey}>The album open in Google Photos</option>}
            {albums?.map((a) => <option key={a.mediaKey} value={a.mediaKey}>{a.title}{a.shared ? " (shared)" : ""}</option>)}
          </select>
        )
      )}

      <div class="look-for">
        <label class="opt" title="Overlapping photos taken seconds apart, ready to stitch"><input type="checkbox" checked={detectors.panorama} onChange={() => toggle("panorama")} /> Panoramas</label>
        <label class="opt" title="Photos that look the same. You choose how similar in the results. Copies are only found among the photos looked through."><input type="checkbox" checked={detectors.duplicates} onChange={() => toggle("duplicates")} /> Duplicates</label>
        <div class="row">
          <label class="opt" title="Photos and videos whose date differs from the date in their file name"><input type="checkbox" checked={detectors.dates} onChange={() => toggle("dates")} /> Wrong dates</label>
          <button class="btn small" title="The filename formats this account knows" onClick={run(() => Messenger.toBackground({ type: "panel.openSettings", tabId }))}>Formats…</button>
        </div>
        <label class="opt small" title="Scans reuse saved results and only check new photos. Tick this to check everything again."><input type="checkbox" checked={recheck} onChange={() => setRecheck(!recheck)} /> Re-check all</label>
      </div>

      {error && <ErrorBox error={error} />}
      <div class="row bulk-go">
        {activity && <button class="btn small" title="Back to the scan window" onClick={run(() => gateway.restoreModal())}>{activity.busy ? activity.label : "Show results"}</button>}
        <button class="btn primary" disabled={activity?.busy ?? false} title={activity?.busy ? "Finish or close the running one first" : undefined} onClick={() => void start()}>Scan</button>
      </div>
    </section>
  );
}
