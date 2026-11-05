/** Library scan page: find panorama candidates (and later more), review, create in bulk, see results. */

import { useState } from "preact/hooks";
import type { ScanScopeKind } from "../../scan/scan-scope.js";
import { bootEditor, ErrorBox, Segmented, useSnapshot } from "../editor/editor-ui.js";
import { PanoramaFormat } from "../editor/panorama/panorama-ui.js";
import { ScanSession, type CandidateView, type ScanSnapshot } from "./scan-session.js";

function Setup(props: { session: ScanSession; snap: ScanSnapshot }) {
  const { session, snap } = props;
  const scopes: { value: ScanScopeKind; label: string }[] = [
    { value: "dateRange", label: "Date range" },
    { value: "album", label: "Album" },
    ...(snap.selection.length > 0 ? [{ value: "selection" as const, label: `Selected (${snap.selection.length})` }] : []),
    { value: "library", label: "Whole library" },
  ];
  const presets: { label: string; from: Date; to: Date }[] = (() => {
    const now = new Date();
    return [
      { label: "Last 30 days", from: new Date(now.getTime() - 30 * 86_400_000), to: now },
      { label: "Last 12 months", from: new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()), to: now },
      { label: "This year", from: new Date(now.getFullYear(), 0, 1), to: now },
      { label: "Last year", from: new Date(now.getFullYear() - 1, 0, 1), to: new Date(now.getFullYear() - 1, 11, 31) },
    ];
  })();

  return (
    <section class="card setup">
      <div class="group">
        <strong>Look through</strong>
        <Segmented<ScanScopeKind> label="Scope" value={snap.scopeKind} disabled={false} options={scopes} onChange={(k) => session.setScopeKind(k)} />
        {snap.scopeKind === "dateRange" && (
          <>
            <div class="row">
              <label class="field inline">From <input type="date" value={snap.from} max={snap.to} onChange={(e) => session.setDates((e.target as HTMLInputElement).value, snap.to)} /></label>
              <label class="field inline">To <input type="date" value={snap.to} min={snap.from} onChange={(e) => session.setDates(snap.from, (e.target as HTMLInputElement).value)} /></label>
            </div>
            <div class="row">{presets.map((p) => <button key={p.label} class="btn small" onClick={() => session.setDates(ScanSession.isoDate(p.from), ScanSession.isoDate(p.to))}>{p.label}</button>)}</div>
          </>
        )}
        {snap.scopeKind === "album" && (
          snap.albums.status === "loading" ? <div class="muted small">Loading your albums…</div>
          : snap.albums.status === "failed" && snap.albums.error ? <><ErrorBox error={snap.albums.error} /><button class="btn small" onClick={() => void session.loadAlbums()}>Try again</button></>
          : (
            <select value={snap.albumKey ?? ""} onChange={(e) => session.setAlbum((e.target as HTMLSelectElement).value)} aria-label="Album">
              <option value="" disabled>Choose an album…</option>
              {snap.params.albumKey && !snap.albums.items.some((a) => a.mediaKey === snap.params.albumKey) && <option value={snap.params.albumKey}>The album open in Google Photos</option>}
              {snap.albums.items.map((a) => <option key={a.mediaKey} value={a.mediaKey}>{a.title}{a.shared ? " (shared)" : ""}</option>)}
            </select>
          )
        )}
        {snap.scopeKind === "selection" && <div class="muted small">The {snap.selection.length} photos you selected in Google Photos.</div>}
        {snap.scopeKind === "library" && <div class="muted small">Every photo in your library. Listing is quick; checking long bursts of photos takes longer.</div>}
      </div>

      <div class="group">
        <strong>Look for</strong>
        <label class="opt"><input type="checkbox" checked={snap.detectors.panorama} onChange={() => session.toggleDetector("panorama")} /> Panoramas</label>
        <div class="muted small">Overlapping photos taken seconds apart. Each group is checked and previewed before anything is created.</div>
        <div class="muted small">More checks will be added here (metadata, duplicates, …).</div>
      </div>

      {snap.scanError && <ErrorBox error={snap.scanError} />}
      <div class="row end">
        <button class="btn primary" onClick={() => void session.startScan()}>Scan</button>
      </div>
    </section>
  );
}

function Candidate(props: { session: ScanSession; snap: ScanSnapshot; view: CandidateView }) {
  const { session, snap, view } = props;
  const c = view.candidate;
  const first = c.items[0]!;
  const busy = snap.phase.name === "creating";
  const status =
    view.status === "created" ? <span class="pill ok">Created</span>
    : view.status === "working" ? <span class="pill">{view.step ?? "Working…"}</span>
    : view.status === "queued" ? <span class="pill">Waiting</span>
    : view.status === "failed" ? <span class="pill danger">Failed</span>
    : c.alreadyMade ? <a class="pill warn" href={c.alreadyMade.webUrl} target="_blank" rel="noreferrer" title="Pixlixir already saved a panorama from these photos">Already made ↗</a>
    : !c.preview ? <span class="pill warn">Could not preview</span>
    : null;
  return (
    <li class={`cand ${view.status}`}>
      <div class="cand-preview">
        {view.previewUrl ? <img src={view.previewUrl} alt={`Panorama preview of ${c.items.length} photos`} /> : <div class="muted small pad">{c.previewError?.message ?? "No preview"}</div>}
      </div>
      <div class="cand-body">
        <div class="row between">
          <label class="opt">
            <input type="checkbox" checked={view.selected} disabled={busy || view.status === "created" || view.status === "working"} onChange={() => session.toggleCandidate(c.id)} />
            <strong>{c.items.length} photos</strong>
            <span class="muted small">· {PanoramaFormat.date(first.takenAtMs, first.timezoneOffsetMs)}</span>
          </label>
          {status}
        </div>
        <div class="strip">
          {c.items.map((i) => (snap.thumbs[i.mediaKey] ? <img key={i.mediaKey} src={snap.thumbs[i.mediaKey]} alt="" /> : <span key={i.mediaKey} class="ph" />))}
          {c.duplicates.map((i) => (snap.thumbs[i.mediaKey] ? <img key={i.mediaKey} class="dup" src={snap.thumbs[i.mediaKey]} alt="" title="Retake of another photo — left out" /> : null))}
        </div>
        <div class="muted small">
          {c.preview ? `${c.preview.motion === "flat" ? "Moving over a flat surface" : "Turning in place"}` : ""}
          {c.preview && c.preview.dropped.length > 0 ? ` · ${c.preview.dropped.length} photo${c.preview.dropped.length > 1 ? "s" : ""} did not connect` : ""}
          {c.duplicates.length > 0 ? ` · ${c.duplicates.length} retake${c.duplicates.length > 1 ? "s" : ""} left out` : ""}
        </div>
        {view.result && (
          <div class="small">
            <a href={view.result.webUrl} target="_blank" rel="noreferrer">Open in Google Photos ↗</a>
            <span class="muted"> · {view.result.width.toLocaleString()} × {view.result.height.toLocaleString()} px{view.result.albums.length > 0 ? ` · added to ${view.result.albums.map((a) => `“${a}”`).join(", ")}` : ""}</span>
            {view.result.skipped > 0 && <div class="err">{view.result.skipped} photo(s) could not be loaded and were left out.</div>}
            {[...view.result.problems, ...view.result.warnings].map((p, i) => <div key={i} class="err">{p}</div>)}
          </div>
        )}
        {view.error && <ErrorBox error={view.error} />}
        {view.status !== "created" && !busy && <div><button class="btn small" onClick={() => void session.openInEditor(c.id)}>Open in editor</button></div>}
      </div>
    </li>
  );
}

function Results(props: { snap: ScanSnapshot }) {
  const created = props.snap.candidates.filter((c) => c.status === "created");
  const failed = props.snap.candidates.filter((c) => c.status === "failed");
  if (created.length === 0 && failed.length === 0) return null;
  return (
    <section class="card results" aria-live="polite">
      <strong>{created.length} panorama{created.length === 1 ? "" : "s"} created{failed.length > 0 ? `, ${failed.length} failed` : ""}</strong>
      <div class="muted small">Each is a new item dated like its first photo, with the photos’ location and description, in the same albums. Your photos were not changed. They are also listed under Recent work in the side panel.</div>
      <ul class="made">
        {created.map((c) => (
          <li key={c.candidate.id}>
            <a href={c.result!.webUrl} target="_blank" rel="noreferrer">
              {c.previewUrl && <img src={c.previewUrl} alt="" />}
              <span>{PanoramaFormat.date(c.candidate.items[0]!.takenAtMs, c.candidate.items[0]!.timezoneOffsetMs)} ↗</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function App(props: { session: ScanSession }) {
  const { session } = props;
  const snap = useSnapshot(session);
  const [confirming, setConfirming] = useState(false);
  const { phase } = snap;
  const selected = session.selectedCount();
  const scanning = phase.name === "scanning";

  return (
    <div class="app">
      <header>
        <div class="title">
          <span class="logo">✦</span>
          <h1>Scan library</h1>
          <span class="muted">Find photos to turn into panoramas</span>
        </div>
        <span class="pill" title="The scan reads this Google account">Account: <strong>{snap.params.email}</strong></span>
      </header>

      {phase.name === "failed" ? (
        <div class="center"><ErrorBox error={phase.error} /></div>
      ) : (
        <div class="scan-main">
          {phase.name === "setup" && <Setup session={session} snap={snap} />}

          {phase.name !== "setup" && (
            <section class="card status-bar">
              <div class="row between">
                <span>
                  <strong>{snap.scopeLabel}</strong>
                  {snap.summary && <span class="muted small"> · {snap.summary.photos.toLocaleString()} photos looked at · {snap.candidates.length} group{snap.candidates.length === 1 ? "" : "s"} found · {snap.summary.seconds}s</span>}
                </span>
                {scanning ? <button class="btn" onClick={() => session.stopScan()}>Stop</button> : phase.name !== "creating" && <button class="btn" onClick={() => session.newScan()}>New scan</button>}
              </div>
              {scanning && (
                <div class="progress-line" aria-live="polite">
                  {phase.step}{phase.total !== null && phase.done !== null ? ` · ${phase.done} of ${phase.total}` : ""}{snap.progress ? ` · ${snap.progress}` : ""}
                  {phase.total !== null && phase.done !== null && <progress max={phase.total} value={phase.done} />}
                </div>
              )}
              {snap.scanError && <ErrorBox error={snap.scanError} />}
            </section>
          )}

          <Results snap={snap} />

          {phase.name !== "setup" && snap.candidates.length === 0 && !scanning && <div class="muted center-text">No panorama groups found in this scope.</div>}
          {snap.candidates.length > 0 && <ul class="cands">{snap.candidates.map((v) => <Candidate key={v.candidate.id} session={session} snap={snap} view={v} />)}</ul>}
        </div>
      )}

      {snap.candidates.length > 0 && (phase.name === "review" || phase.name === "creating" || scanning) && (
        <footer>
          <button class="btn small" disabled={phase.name === "creating"} onClick={() => session.selectAll(true)}>Select all</button>
          <button class="btn small" disabled={phase.name === "creating"} onClick={() => session.selectAll(false)}>Select none</button>
          <div class="grow" />
          <span class="muted">Your photos are never changed.</span>
          {phase.name === "creating" ? (
            <>
              <span>Creating {Math.min(phase.done + 1, phase.total)} of {phase.total}…{snap.progress ? ` ${snap.progress}` : ""}</span>
              <button class="btn" onClick={() => session.stopCreating()}>Stop after this one</button>
            </>
          ) : (
            <button class="btn primary" disabled={selected === 0 || scanning} onClick={() => setConfirming(true)}>Create {selected} panorama{selected === 1 ? "" : "s"}</button>
          )}
        </footer>
      )}

      {confirming && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="modal card">
            <h2 id="confirm-title">Create {selected} panorama{selected === 1 ? "" : "s"}?</h2>
            <p>Each is stitched at full size (up to 60 MP) and uploaded as a <strong>new item</strong> to <strong>{snap.params.email}</strong>. Your photos stay exactly as they are.</p>
            <ul class="inherit small">
              <li>Dated like its earliest photo, so it sits next to them in your timeline</li>
              <li>The photos’ location, camera details and description</li>
              <li>Added to every album that holds its photos (including shared albums, which other people can see)</li>
            </ul>
            <p class="muted small">This can take a few minutes. Keep this tab and a Google Photos tab open.</p>
            <div class="row end">
              <button class="btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button class="btn primary" autofocus onClick={() => { setConfirming(false); void session.createSelected(); }}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

bootEditor(() => new ScanSession(ScanSession.paramsFromUrl(location.search)), (session) => <App session={session} />);
