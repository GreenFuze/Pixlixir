/** Library scan (shown as a modal over Google Photos): find panorama candidates, review, create in bulk, see results. */

import { useEffect, useState } from "preact/hooks";
import { ScanEta } from "../../scan/scan-eta.js";
import { bootEditor, ErrorBox, useSnapshot } from "../editor/editor-ui.js";
import { PanoramaEditor } from "../editor/panorama/panorama-editor.js";
import { PanoramaFormat } from "../editor/panorama/panorama-ui.js";
import { ScanSession, type CandidateView, type ScanSnapshot } from "./scan-session.js";

/** Bar + one status line for whichever stage is running. */
function Progress(props: { snap: ScanSnapshot }) {
  const { phase, candidates, progress } = props.snap;
  if (phase.name !== "scanning" && phase.name !== "creating" && phase.name !== "fixingDates") return null;
  const found = candidates.length;
  let text: string;
  let done: number | null;
  let total: number | null;
  if (phase.name === "creating") {
    done = phase.done;
    total = phase.total;
    text = `Creating ${Math.min(phase.done + 1, phase.total)} of ${phase.total}`;
  } else if (phase.name === "fixingDates") {
    done = phase.done;
    total = phase.total;
    text = `Changing dates: ${phase.done.toLocaleString()} of ${phase.total.toLocaleString()}`;
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

function DateFixes(props: { session: ScanSession; snap: ScanSnapshot; onFix: () => void; onUndo: () => void }) {
  const { session, snap, onFix, onUndo } = props;
  const { dateFixes, dateFixesShown } = snap;
  const fixing = snap.phase.name === "fixingDates";
  const busy = fixing || snap.phase.name === "creating" || snap.phase.name === "scanning";
  const fixed = dateFixes.filter((d) => d.fixed).length;
  const selected = session.selectedDateFixes();
  return (
    <section class="card dates">
      <div class="row between">
        <strong title="The date in the file name differs from the date in Google Photos">{dateFixes.length.toLocaleString()} wrong date{dateFixes.length === 1 ? "" : "s"}{fixed > 0 ? `, ${fixed.toLocaleString()} fixed` : ""}</strong>
        <div class="row">
          <button class="btn small" disabled={busy} onClick={() => session.selectAllDateFixes(true)}>All</button>
          <button class="btn small" disabled={busy} onClick={() => session.selectAllDateFixes(false)}>None</button>
          {snap.undoableDateFix && <button class="btn small" disabled={busy} title="Put back the dates from before this run" onClick={onUndo}>Undo</button>}
          <button class="btn primary small" disabled={busy || selected === 0} onClick={onFix}>Fix {selected.toLocaleString()}</button>
        </div>
      </div>
      {snap.dateFixError && <ErrorBox error={snap.dateFixError} />}
      <ul class="date-rows">
        {dateFixes.slice(0, dateFixesShown).map((d) => {
          const { item, fileName, mask, newTakenAtMs } = d.finding;
          return (
            <li key={d.finding.id} class={d.fixed ? "fixed" : ""}>
              <input type="checkbox" aria-label={`Fix ${fileName}`} checked={d.selected} disabled={busy || d.fixed} onChange={() => session.toggleDateFix(item.mediaKey)} />
              {d.thumbUrl ? <img src={d.thumbUrl} alt="" /> : <span class="ph" />}
              <span class="date-name" title={`Format: ${mask}`}>{fileName}</span>
              <span class="date-change">
                <span class="muted">{PanoramaFormat.date(item.takenAtMs, item.timezoneOffsetMs)}</span> → <strong>{PanoramaFormat.date(newTakenAtMs, item.timezoneOffsetMs)}</strong>
              </span>
              {d.fixed && <span class="pill ok">Fixed</span>}
            </li>
          );
        })}
      </ul>
      {dateFixes.length > dateFixesShown && <button class="btn small" onClick={() => session.showMoreDateFixes()}>Show more ({(dateFixes.length - dateFixesShown).toLocaleString()})</button>}
    </section>
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
  const [confirmingDates, setConfirmingDates] = useState<"fix" | "undo" | null>(null);
  const { phase } = snap;
  const selected = session.selectedCount();
  const scanning = phase.name === "scanning";
  const creating = phase.name === "creating";
  const fixingDates = phase.name === "fixingDates";

  // Paragraph: Escape closes the topmost thing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || snap.editor) return;
      if (confirmingDates) setConfirmingDates(null);
      else if (confirming) setConfirming(false);
      else if (snap.confirmingClose) session.cancelClose();
      else session.requestClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [confirming, confirmingDates, snap.confirmingClose, phase.name, snap.editor]);

  if (snap.editor) {
    return <PanoramaEditor key={snap.editor.candidateId} session={snap.editor.session} back={{ label: "← Back", title: "Back to the scan results", onBack: () => session.closeEditor(), escape: true }} />;
  }

  return (
    <div class="app">
      <header>
        <div class="title">
          <span class="logo">✦</span>
          <h1>{snap.detectors.panorama || !snap.detectors.dates ? "Scan library" : "Fix dates"}</h1>
        </div>
        <div class="row">
          <span class="pill" title="The scan reads this Google account">{snap.params.email}</span>
          {(scanning || creating || fixingDates || phase.name === "review") && <button class="btn icon small" title="Minimize: keeps running, with progress on the Pixlixir chip" aria-label="Minimize" onClick={() => session.minimize()}>–</button>}
          <button class="btn icon small" title="Close" aria-label="Close" onClick={() => session.requestClose()}>✕</button>
        </div>
      </header>

      {phase.name === "failed" ? (
        <div class="center"><ErrorBox error={phase.error} /></div>
      ) : (
        <div class="scan-main">
          <section class="card status-bar">
              <div class="row between">
                <span>
                  <strong>{snap.scopeLabel}</strong>
                  {snap.summary && <span class="muted small"> · {snap.summary.photos.toLocaleString()} photos · {snap.detectors.panorama ? `${snap.candidates.length} group${snap.candidates.length === 1 ? "" : "s"}` : `${snap.dateFixes.length.toLocaleString()} wrong`}</span>}
                  {snap.summary && snap.summary.unmatchedNames > 0 && <span class="muted small" title="Add their format in Settings to include them"> · {snap.summary.unmatchedNames.toLocaleString()} name{snap.summary.unmatchedNames === 1 ? "" : "s"} match no format</span>}
                  {snap.summary && snap.summary.photosReused > 0 && <span class="muted small" title="Answered from saved results, without checking them again"> · {snap.summary.photosReused.toLocaleString()} already checked</span>}
                </span>
                {scanning ? <button class="btn small" onClick={() => session.stopScan()}>Stop</button> : fixingDates ? <button class="btn small" title="Stops after this batch" onClick={() => session.stopCreating()}>Stop</button> : !creating && <button class="btn small" title="Run this scan again" onClick={() => session.scanAgain()}>Scan again</button>}
              </div>
              <Progress snap={snap} />
              {snap.scanError && <ErrorBox error={snap.scanError} />}
              {snap.summary && snap.summary.failures.length > 0 && <div class="err" title={snap.summary.failures[0]!.message}>{snap.summary.failures.length} sequence{snap.summary.failures.length === 1 ? "" : "s"} could not be checked: {snap.summary.failures[0]!.message}</div>}
          </section>

          <Results snap={snap} />

          {snap.dateFixes.length > 0 && <DateFixes session={session} snap={snap} onFix={() => setConfirmingDates("fix")} onUndo={() => setConfirmingDates("undo")} />}
          {snap.candidates.length === 0 && snap.dateFixes.length === 0 && !scanning && !snap.scanError && <div class="muted center-text">{snap.summary ? "Nothing found." : "Stopped."}</div>}
          {snap.candidates.length > 0 && <ul class="cands">{snap.candidates.map((v) => <Candidate key={v.candidate.id} session={session} snap={snap} view={v} />)}</ul>}
        </div>
      )}

      {snap.candidates.length > 0 && (phase.name === "review" || creating || scanning || fixingDates) && (
        <footer>
          <button class="btn small" disabled={creating} onClick={() => session.selectAll(true)}>All</button>
          <button class="btn small" disabled={creating} onClick={() => session.selectAll(false)}>None</button>
          <div class="grow" />
          {creating ? (
            <button class="btn" onClick={() => session.stopCreating()}>Stop after this one</button>
          ) : (
            <button class="btn primary" disabled={selected === 0 || scanning || fixingDates} onClick={() => setConfirming(true)}>Create {selected}</button>
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

      {confirmingDates && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="dates-title">
          <div class="modal card">
            <h2 id="dates-title">{confirmingDates === "fix" ? `Change ${session.selectedDateFixes().toLocaleString()} date${session.selectedDateFixes() === 1 ? "" : "s"}?` : "Put the old dates back?"}</h2>
            <p>
              {confirmingDates === "fix"
                ? <>These items change <strong>in place</strong> in <strong>{snap.params.email}</strong> and move in your timeline. Albums, sharing and edits stay. You can undo this run until you close or start a new scan.</>
                : <>The items changed in this run go back to their earlier dates in <strong>{snap.params.email}</strong>.</>}
            </p>
            <div class="row end">
              <button class="btn" autofocus onClick={() => setConfirmingDates(null)}>Cancel</button>
              <button class="btn primary" onClick={() => { const action = confirmingDates; setConfirmingDates(null); void (action === "fix" ? session.fixSelectedDates() : session.undoDateFixes()); }}>{confirmingDates === "fix" ? "Change dates" : "Put back"}</button>
            </div>
          </div>
        </div>
      )}

      {snap.confirmingClose && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="close-title">
          <div class="modal card">
            <h2 id="close-title">{creating ? "Stop creating panoramas?" : fixingDates ? "Stop changing dates?" : "Stop the scan?"}</h2>
            <p>{creating ? "Panoramas already created stay in your library." : fixingDates ? "Dates already changed stay changed. Undo is lost once this closes." : "What it found so far will be lost."}</p>
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
