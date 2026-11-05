/** Library scan (shown as a modal over Google Photos): find panorama candidates, review, create in bulk, see results. */

import { useEffect, useState } from "preact/hooks";
import { ScanEta } from "../../scan/scan-eta.js";
import type { ScanScopeKind } from "../../scan/scan-scope.js";
import { bootEditor, ErrorBox, Segmented, useSnapshot } from "../editor/editor-ui.js";
import { PanoramaEditor } from "../editor/panorama/panorama-editor.js";
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
  const now = new Date();
  const presets: { label: string; from: Date; to: Date }[] = [
    { label: "30 days", from: new Date(now.getTime() - 30 * 86_400_000), to: now },
    { label: "12 months", from: new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()), to: now },
    { label: "This year", from: new Date(now.getFullYear(), 0, 1), to: now },
    { label: "Last year", from: new Date(now.getFullYear() - 1, 0, 1), to: new Date(now.getFullYear() - 1, 11, 31) },
  ];

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
          snap.albums.status === "loading" ? <div class="muted small">Loading albums…</div>
          : snap.albums.status === "failed" && snap.albums.error ? <><ErrorBox error={snap.albums.error} /><button class="btn small" onClick={() => void session.loadAlbums()}>Try again</button></>
          : (
            <select value={snap.albumKey ?? ""} onChange={(e) => session.setAlbum((e.target as HTMLSelectElement).value)} aria-label="Album">
              <option value="" disabled>Choose an album…</option>
              {snap.params.albumKey && !snap.albums.items.some((a) => a.mediaKey === snap.params.albumKey) && <option value={snap.params.albumKey}>The album open in Google Photos</option>}
              {snap.albums.items.map((a) => <option key={a.mediaKey} value={a.mediaKey}>{a.title}{a.shared ? " (shared)" : ""}</option>)}
            </select>
          )
        )}
      </div>

      <div class="group">
        <strong>Look for</strong>
        <label class="opt" title="Overlapping photos taken seconds apart. Each group is previewed before anything is created."><input type="checkbox" checked={snap.detectors.panorama} onChange={() => session.toggleDetector("panorama")} /> Panoramas</label>
        <label class="opt small" title="Scans reuse saved results and only check new photos. Tick this to check everything again."><input type="checkbox" checked={snap.recheck} onChange={() => session.toggleRecheck()} /> Re-check all</label>
      </div>

      {snap.scanError && <ErrorBox error={snap.scanError} />}
      <div class="row end">
        <button class="btn primary" onClick={() => void session.startScan()}>Scan</button>
      </div>
    </section>
  );
}

/** Bar + one status line for whichever stage is running. */
function Progress(props: { snap: ScanSnapshot }) {
  const { phase, candidates, progress } = props.snap;
  if (phase.name !== "scanning" && phase.name !== "creating") return null;
  const found = candidates.length;
  let text: string;
  let done: number | null;
  let total: number | null;
  if (phase.name === "creating") {
    done = phase.done;
    total = phase.total;
    text = `Creating ${Math.min(phase.done + 1, phase.total)} of ${phase.total}`;
  } else {
    done = phase.done;
    total = phase.total;
    text = total !== null && done !== null ? `${phase.step}: ${done.toLocaleString()} of ${total.toLocaleString()}` : phase.step;
    if (found > 0) text += ` · ${found} found`;
    if (phase.secondsLeft !== null && phase.secondsLeft > 0) text += ` · ${ScanEta.format(phase.secondsLeft)}`;
  }
  return (
    <div class="progress-line" aria-live="polite">
      {total !== null && done !== null ? <progress max={Math.max(total, 1)} value={done} /> : <progress />}
      <span>{text}</span>
      {progress && <span class="muted small">{progress}</span>}
    </div>
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
    : null;
  return (
    <li class={`cand ${view.status}`}>
      <div class="cand-preview">
        <img src={view.previewUrl} alt={`Panorama preview of ${c.items.length} photos`} />
      </div>
      <div class="cand-body">
        <div class="row between">
          <label class="opt">
            <input type="checkbox" checked={view.selected} disabled={busy || view.status === "created" || view.status === "working"} onChange={() => session.toggleCandidate(c.id)} />
            <strong>{c.items.length} photos</strong>
            <span class="muted small">{PanoramaFormat.date(first.takenAtMs, first.timezoneOffsetMs)}</span>
          </label>
          {status}
        </div>
        <div class="strip">
          {c.items.map((i) => (snap.thumbs[i.mediaKey] ? <img key={i.mediaKey} src={snap.thumbs[i.mediaKey]} alt="" /> : <span key={i.mediaKey} class="ph" />))}
        </div>
        {c.preview.motion === "flat" && <div class="row"><span class="pill" title="Stitched as photos of a flat surface, because turning in place did not align">Flat surface</span></div>}
        {view.result && (
          <div class="small">
            <a href={view.result.webUrl} target="_blank" rel="noreferrer">Open ↗</a>
            <span class="muted"> {view.result.width.toLocaleString()} × {view.result.height.toLocaleString()} px{view.result.albums.length > 0 ? ` · ${view.result.albums.map((a) => `“${a}”`).join(", ")}` : ""}</span>
            {view.result.skipped > 0 && <div class="err">{view.result.skipped} photo(s) could not be loaded and were left out.</div>}
            {[...view.result.problems, ...view.result.warnings].map((p, i) => <div key={i} class="err">{p}</div>)}
          </div>
        )}
        {view.error && <ErrorBox error={view.error} />}
        {view.status !== "created" && !busy && <div><button class="btn small" disabled={snap.phase.name === "scanning"} title="Adjust settings and save this one by hand" onClick={() => void session.openInEditor(c.id)}>Edit…</button></div>}
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
      <strong title="New items dated like their first photo, with the photos’ location and description, in the same albums. Also listed under Recent work in the side panel.">
        {created.length} created{failed.length > 0 ? `, ${failed.length} failed` : ""}
      </strong>
      <ul class="made">
        {created.map((c) => (
          <li key={c.candidate.id}>
            <a href={c.result!.webUrl} target="_blank" rel="noreferrer" title="Open in Google Photos">
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
  const creating = phase.name === "creating";

  // Paragraph: Escape closes the topmost thing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || snap.editor) return;
      if (confirming) setConfirming(false);
      else if (snap.confirmingClose) session.cancelClose();
      else session.requestClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [confirming, snap.confirmingClose, phase.name, snap.editor]);

  if (snap.editor) {
    return <PanoramaEditor key={snap.editor.candidateId} session={snap.editor.session} back={{ label: "← Back", title: "Back to the scan results", onBack: () => session.closeEditor(), escape: true }} />;
  }

  return (
    <div class="app">
      <header>
        <div class="title">
          <span class="logo">✦</span>
          <h1>Scan library</h1>
        </div>
        <div class="row">
          <span class="pill" title="The scan reads this Google account">{snap.params.email}</span>
          {(scanning || creating || phase.name === "review") && <button class="btn icon small" title="Minimize: keeps running, with progress on the Pixlixir chip" aria-label="Minimize" onClick={() => session.minimize()}>–</button>}
          <button class="btn icon small" title="Close" aria-label="Close" onClick={() => session.requestClose()}>✕</button>
        </div>
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
                  {snap.summary && <span class="muted small"> · {snap.summary.photos.toLocaleString()} photos · {snap.candidates.length} group{snap.candidates.length === 1 ? "" : "s"}</span>}
                  {snap.summary && snap.summary.photosReused > 0 && <span class="muted small" title="Answered from saved results, without checking them again"> · {snap.summary.photosReused.toLocaleString()} already checked</span>}
                </span>
                {scanning ? <button class="btn small" onClick={() => session.stopScan()}>Stop</button> : !creating && <button class="btn small" onClick={() => session.newScan()}>New scan</button>}
              </div>
              <Progress snap={snap} />
              {snap.scanError && <ErrorBox error={snap.scanError} />}
              {snap.summary && snap.summary.failures.length > 0 && <div class="err" title={snap.summary.failures[0]!.message}>{snap.summary.failures.length} sequence{snap.summary.failures.length === 1 ? "" : "s"} could not be checked: {snap.summary.failures[0]!.message}</div>}
            </section>
          )}

          <Results snap={snap} />

          {phase.name !== "setup" && snap.candidates.length === 0 && !scanning && <div class="muted center-text">No panorama groups found.</div>}
          {snap.candidates.length > 0 && <ul class="cands">{snap.candidates.map((v) => <Candidate key={v.candidate.id} session={session} snap={snap} view={v} />)}</ul>}
        </div>
      )}

      {snap.candidates.length > 0 && (phase.name === "review" || creating || scanning) && (
        <footer>
          <button class="btn small" disabled={creating} onClick={() => session.selectAll(true)}>All</button>
          <button class="btn small" disabled={creating} onClick={() => session.selectAll(false)}>None</button>
          <div class="grow" />
          {creating ? (
            <button class="btn" onClick={() => session.stopCreating()}>Stop after this one</button>
          ) : (
            <button class="btn primary" disabled={selected === 0 || scanning} onClick={() => setConfirming(true)}>Create {selected}</button>
          )}
        </footer>
      )}

      {confirming && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="modal card">
            <h2 id="confirm-title">Create {selected} panorama{selected === 1 ? "" : "s"}?</h2>
            <p>Each is saved as a <strong>new item</strong> to <strong>{snap.params.email}</strong>. Your photos stay exactly as they are.</p>
            <ul class="inherit small">
              <li>The earliest photo’s date and camera details</li>
              <li>The photos’ location and description</li>
              <li>Every album holding its photos, including shared albums other people can see</li>
            </ul>
            <div class="row end">
              <button class="btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button class="btn primary" autofocus onClick={() => { setConfirming(false); void session.createSelected(); }}>Create</button>
            </div>
          </div>
        </div>
      )}

      {snap.confirmingClose && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="close-title">
          <div class="modal card">
            <h2 id="close-title">{creating ? "Stop creating panoramas?" : "Stop the scan?"}</h2>
            <p>{creating ? "Panoramas already created stay in your library." : "What it found so far will be lost."}</p>
            <div class="row end">
              <button class="btn" autofocus onClick={() => session.cancelClose()}>Keep going</button>
              <button class="btn" onClick={() => session.minimize()}>Minimize</button>
              <button class="btn danger" onClick={() => session.close()}>Stop and close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

bootEditor(() => new ScanSession(ScanSession.paramsFromUrl(location.search)), (session) => <App session={session} />);
