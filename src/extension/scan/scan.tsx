/** Library scan (shown as a modal over Google Photos): find panorama candidates, review, create in bulk, see results. */

import { useEffect, useState } from "preact/hooks";
import { DuplicatePlans, DuplicateSimilarity, type DuplicateGroup } from "../../scan/duplicates.js";
import type { DetectorId } from "../../scan/scan-detector.js";
import { ScanEta } from "../../scan/scan-eta.js";
import { bootEditor, ErrorBox, useSnapshot } from "../editor/editor-ui.js";
import { PanoramaEditor } from "../editor/panorama/panorama-editor.js";
import { PanoramaFormat, TrashOriginalsDialog } from "../editor/panorama/panorama-ui.js";
import { DateFixRow, ScanSession, type CandidateView, type DateFixView, type ScanSnapshot } from "./scan-session.js";
import { ScanTabs } from "./scan-tabs.js";

/** Bar + one status line for whichever stage is running. */
function Progress(props: { snap: ScanSnapshot }) {
  const { phase, candidates, progress } = props.snap;
  if (phase.name !== "scanning" && phase.name !== "creating" && phase.name !== "fixingDates" && phase.name !== "findingOriginals" && phase.name !== "trashing") return null;
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
  } else if (phase.name === "trashing") {
    done = phase.done;
    total = phase.total;
    text = `Moving to trash: ${phase.done.toLocaleString()} of ${phase.total.toLocaleString()}`;
  } else {
    done = phase.done;
    total = phase.total;
    text = total !== null && done !== null ? `${phase.step}: ${done.toLocaleString()} of ${total.toLocaleString()}` : phase.step;
    if (phase.name === "scanning" && found > 0) text += ` · ${found} found`;
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

function Candidate(props: { session: ScanSession; snap: ScanSnapshot; view: CandidateView; onTrash: (ids: string[]) => void }) {
  const { session, snap, view, onTrash } = props;
  const c = view.candidate;
  const first = c.items[0]!;
  const busy = snap.phase.name === "creating" || snap.phase.name === "trashing";
  const trashed = view.result?.job.originalsTrash?.state === "moved";
  const status =
    view.status === "created" ? <span class="pill ok">Created</span>
    : view.status === "working" ? <span class="pill">{view.step ?? "Working…"}</span>
    : view.status === "queued" ? <span class="pill">Waiting</span>
    : view.status === "failed" ? <span class="pill danger">Failed</span>
    : c.alreadyMade ? <a class="pill warn" href={c.alreadyMade.webUrl} target="_blank" rel="noreferrer" title="Pixlixir already saved a panorama from these photos">Already made ↗</a>
    : null;
  return (
    <li class={`cand ${view.status}${view.selected ? "" : " unticked"}`}>
      <div class="cand-preview" onClick={() => { if (!busy) session.toggleCandidate(c.id); }}>
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
            <div class="row">
              <a href={view.result.webUrl} target="_blank" rel="noreferrer">Open ↗</a>
              {trashed
                ? <span class="pill">Originals in trash</span>
                : ScanSession.trashableKeys(view).length > 0 && <button class="btn small danger" disabled={snap.phase.name !== "review"} title="Move the photos in this panorama to Google Photos’ trash" onClick={() => onTrash([c.id])}>Trash originals</button>}
            </div>
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

const COPY_HELP = "The file name holds the day this copy was saved, not taken, as with an Instagram export. The right date can only come from the original, so the name is not used.";

/** The (?) on each date row. */
function RowHelp(props: { row: DateFixView }) {
  return <span class="row-help" tabIndex={0} role="img" aria-label="What this row means" title={DateFixRow.help(props.row, PanoramaFormat.date)}>?</span>;
}

/** What could not be read in this scan, and the photo where one is known. */
function ScanFailureList(props: { snap: ScanSnapshot }) {
  const failures = props.snap.summary?.failures ?? [];
  const SHOWN = 5;
  return (
    <>
      {failures.slice(0, SHOWN).map((f, i) => {
        const mediaKey = typeof f.details?.mediaKey === "string" ? f.details.mediaKey : null;
        return (
          <div key={i} class="err" title={f.details ? JSON.stringify(f.details) : undefined}>
            {f.message}
            {mediaKey && <> <a href={`https://photos.google.com/photo/${encodeURIComponent(mediaKey)}?authuser=${encodeURIComponent(props.snap.params.email)}`} target="_blank" rel="noreferrer">Open ↗</a></>}
          </div>
        );
      })}
      {failures.length > SHOWN && <div class="err">and {(failures.length - SHOWN).toLocaleString()} more</div>}
    </>
  );
}

function DateFixes(props: { session: ScanSession; snap: ScanSnapshot; onFix: () => void; onUndo: () => void }) {
  const { session, snap, onFix, onUndo } = props;
  const { dateFixes, dateFixesShown } = snap;
  const fixing = snap.phase.name === "fixingDates";
  const finding = snap.phase.name === "findingOriginals";
  const busy = fixing || finding || snap.phase.name === "creating" || snap.phase.name === "trashing";
  const scanning = snap.phase.name === "scanning";
  const fixed = dateFixes.filter((d) => d.fixed).length;
  const selected = session.selectedDateFixes();
  const wrong = dateFixes.filter((d) => !d.copy).length;
  const copies = dateFixes.length - wrong;
  const shown = dateFixes.slice(0, dateFixesShown);
  return (
    <section class="card dates">
      <div class="row between">
        <strong title="The date in the file name differs from the date in Google Photos">{wrong.toLocaleString()} wrong date{wrong === 1 ? "" : "s"}{fixed > 0 ? `, ${fixed.toLocaleString()} fixed` : ""}</strong>
        <div class="row">
          <button class="btn small" disabled={busy} onClick={() => session.selectAllDateFixes(true)}>All</button>
          <button class="btn small" disabled={busy} onClick={() => session.selectAllDateFixes(false)}>None</button>
          {snap.undoableDateFix && <button class="btn small" disabled={busy || scanning} title="Put back the dates from before this run" onClick={onUndo}>Undo</button>}
          <button class="btn primary small" disabled={busy || scanning || selected === 0} title={scanning ? "Available when the scan ends" : undefined} onClick={onFix}>Fix {selected.toLocaleString()}</button>
        </div>
      </div>
      {snap.dateFixError && <ErrorBox error={snap.dateFixError} />}
      <ul class="date-rows">
        {shown.filter((d) => !d.copy).map((d) => {
          const { item, fileName, newTakenAtMs } = d.finding;
          return (
            <li key={d.finding.id} class={d.fixed ? "fixed" : ""}>
              <input type="checkbox" aria-label={`Fix ${fileName}`} checked={d.selected} disabled={busy || d.fixed} onChange={() => session.toggleDateFix(item.mediaKey)} />
              {d.thumbUrl ? <img src={d.thumbUrl} alt="" /> : <span class="ph" />}
              <span class="date-name">{fileName}</span>
              <RowHelp row={d} />
              <span class="date-change">
                <span class="muted">{PanoramaFormat.date(item.takenAtMs, item.timezoneOffsetMs)}</span> → <strong>{PanoramaFormat.date(newTakenAtMs, item.timezoneOffsetMs)}</strong>
              </span>
              {d.fixed && <span class="pill ok">Fixed</span>}
            </li>
          );
        })}
      </ul>
      {copies > 0 && (
        <div class="row between date-copies">
          <strong title={COPY_HELP}>{copies.toLocaleString()} saved cop{copies === 1 ? "y" : "ies"}</strong>
          {!scanning && dateFixes.some((d) => d.copy && !d.fixed && !d.searched) && <button class="btn small" disabled={busy} title="Continues looking through the library for the larger photo each copy came from, from where it stopped" onClick={() => void session.findOriginals()}>Find originals</button>}
        </div>
      )}
      {copies > 0 && (
        <ul class="date-rows copies">
          {shown.filter((d) => d.copy).map((d) => {
            const { item, fileName } = d.finding;
            const nothingToDo = d.original !== null && !DateFixRow.canTakeOriginal(d);
            return (
              <li key={d.finding.id} class={d.fixed ? "fixed" : ""}>
                {d.original && !nothingToDo && <input type="checkbox" aria-label={`Fix ${fileName}`} checked={d.selected} disabled={busy || d.fixed} onChange={() => session.toggleDateFix(item.mediaKey)} />}
                {d.thumbUrl ? <img src={d.thumbUrl} alt="" /> : <span class="ph" />}
                <span class="date-name">{fileName}</span>
                <RowHelp row={d} />
                <span class="date-change">
                  <span class="muted">{PanoramaFormat.date(item.takenAtMs, item.timezoneOffsetMs)}</span>
                  {d.original && !nothingToDo && <> → <strong>{PanoramaFormat.date(d.original.item.takenAtMs, d.original.item.timezoneOffsetMs)}</strong></>}
                </span>
                {d.original && (
                  <a class="date-original" href={`https://photos.google.com/photo/${encodeURIComponent(d.original.item.mediaKey)}?authuser=${encodeURIComponent(snap.params.email)}`} target="_blank" rel="noreferrer" title={`The likely original, ${d.original.item.width.toLocaleString()} × ${d.original.item.height.toLocaleString()}. Open it to compare`}>
                    {d.original.thumbUrl ? <img src={d.original.thumbUrl} alt="The likely original" /> : <span class="ph" />}
                  </a>
                )}
                {d.original && <span class="pill" title="How alike the copy and the original look">{d.original.similarity}%</span>}
                {nothingToDo && !d.fixed && <span class="pill ok">Date is right</span>}
                {d.searched && !d.original && !d.fixed && <span class="pill">No original</span>}
                {d.fixed && <span class="pill ok">Fixed</span>}
                {!d.fixed && <button class="btn small" disabled={busy} title="This name really is the date taken: move it to wrong dates" onClick={() => session.treatAsWrongDate(item.mediaKey)}>Use name</button>}
              </li>
            );
          })}
        </ul>
      )}
      {dateFixes.length > dateFixesShown && <button class="btn small" onClick={() => session.showMoreDateFixes()}>Show more ({(dateFixes.length - dateFixesShown).toLocaleString()})</button>}
    </section>
  );
}

const fileSize = (bytes: number | null) => (bytes === null ? "" : ` · ${(bytes / 1048576).toFixed(1)} MB`);

function DuplicateRow(props: { session: ScanSession; snap: ScanSnapshot; group: DuplicateGroup; busy: boolean }) {
  const { session, snap, group, busy } = props;
  const view = snap.duplicates!;
  const plan = DuplicatePlans.plan(group, view.choices);
  const lostLocation = plan && !plan.keep.location && plan.trash.some((i) => i.location);
  return (
    <li class="dup-group">
      <div class="dup-tiles">
        {group.members.map((m, n) => {
          const { item, sizeBytes } = m.photo;
          const goes = DuplicatePlans.goes(group, m, view.choices);
          const mine = item.editable !== false;
          const lastToKeep = !goes && group.members.every((o) => o === m || DuplicatePlans.goes(group, o, view.choices));
          return (
            <label key={item.dedupKey} class={goes ? "dup-tile goes" : "dup-tile"} title={`${PanoramaFormat.date(item.takenAtMs, item.timezoneOffsetMs)}${item.location ? " · has a location" : ""}`}>
              {view.thumbs[item.dedupKey] ? <img src={view.thumbs[item.dedupKey]} alt="" /> : <span class="ph" />}
              <span class="dup-caption">
                <input type="checkbox" aria-label="Move to trash" checked={goes} disabled={busy || !mine || lastToKeep} onChange={() => session.toggleDuplicate(group, m)} />
                {n === 0 ? <span class="pill ok" title={group.reason}>Best</span> : <span class="pill" title={m.crop ? "A crop of the best photo" : undefined}>{m.similarity}%{m.crop ? " crop" : ""}</span>}
                {!mine && <span class="pill" title="Someone else’s photo: it cannot be moved to trash">Not yours</span>}
              </span>
              <span class="muted small">{item.width.toLocaleString()} × {item.height.toLocaleString()}{fileSize(sizeBytes)}</span>
            </label>
          );
        })}
      </div>
      {lostLocation && <span class="pill warn" title="The photo that stays has no location, and one going to trash does">Location only on a copy</span>}
    </li>
  );
}

function Duplicates(props: { session: ScanSession; snap: ScanSnapshot; onTrash: () => void }) {
  const { session, snap, onTrash } = props;
  const view = snap.duplicates!;
  const groups = session.duplicateGroups();
  const scanning = snap.phase.name === "scanning";
  const busy = snap.phase.name !== "review" && !scanning;
  const goes = session.duplicatesToTrash();
  return (
    <section class="card dups">
      <div class="row between">
        <label class="opt" title="How alike two photos must look. 100% means everything visible matches, at any size.">
          Similarity
          <input type="range" min={DuplicateSimilarity.MIN_PERCENT} max={DuplicateSimilarity.MAX_PERCENT} step={1} value={view.similarity} disabled={busy} onInput={(e) => session.setDuplicateSimilarity(Number((e.target as HTMLInputElement).value))} />
          <strong>{view.similarity}%</strong>
          <span class="muted small">{groups.length.toLocaleString()} group{groups.length === 1 ? "" : "s"}</span>
        </label>
        <div class="row">
          <button class="btn small" disabled={busy} title="Keep the best of each group, trash the rest" onClick={() => session.chooseAllDuplicates(true)}>All</button>
          <button class="btn small" disabled={busy} title="Trash nothing" onClick={() => session.chooseAllDuplicates(false)}>None</button>
          <button class="btn small danger" disabled={busy || scanning || goes === 0} title={scanning ? "Available when the scan ends" : undefined} onClick={onTrash}>Trash {goes.toLocaleString()}</button>
        </div>
      </div>
      {view.error && <ErrorBox error={view.error} />}
      {view.skippedShared > 0 && <div class="row"><span class="pill warn" title="Adding to shared albums is not verified yet, so these groups keep all their photos">{view.skippedShared} group{view.skippedShared === 1 ? "" : "s"} left alone: shared album</span></div>}
      {view.problems.map((p, i) => <div key={i} class="err">{p.message}</div>)}
      <ul class="dup-groups">{groups.slice(0, view.shown).map((g) => <DuplicateRow key={g.members[0]!.photo.item.dedupKey} session={session} snap={snap} group={g} busy={busy} />)}</ul>
      {groups.length === 0 && <div class="muted center-text">None at this similarity.</div>}
      {groups.length > view.shown && <button class="btn small" onClick={() => session.showMoreDuplicates()}>Show more ({(groups.length - view.shown).toLocaleString()})</button>}
    </section>
  );
}

function Results(props: { session: ScanSession; snap: ScanSnapshot; onTrash: (ids: string[]) => void }) {
  const created = props.snap.candidates.filter((c) => c.status === "created");
  const failed = props.snap.candidates.filter((c) => c.status === "failed");
  if (created.length === 0 && failed.length === 0) return null;
  const withOriginals = props.session.withOriginals();
  return (
    <section class="card results" aria-live="polite">
      <div class="row between">
        <strong title="New items dated like their first photo, with the photos’ location and description, in the same albums. Also listed under Recent work in the side panel.">
          {created.length} created{failed.length > 0 ? `, ${failed.length} failed` : ""}
        </strong>
        {withOriginals.length > 1 && <button class="btn small danger" disabled={props.snap.phase.name !== "review"} title="Move the photos in these panoramas to Google Photos’ trash" onClick={() => props.onTrash(withOriginals.map((c) => c.candidate.id))}>Trash all originals</button>}
      </div>
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

/** One tab per thing this scan looks for. With only one there is nothing to switch, so no bar. */
function TabBar(props: { session: ScanSession; snap: ScanSnapshot; active: DetectorId }) {
  const { session, snap, active } = props;
  const tabs = ScanTabs.list(snap.detectors, { panorama: snap.candidates.length, dates: snap.dateFixes.filter((d) => !d.copy).length, duplicates: session.duplicateGroups().length });
  if (tabs.length < 2) return null;
  const move = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    const next = tabs[(tabs.findIndex((t) => t.id === active) + step + tabs.length) % tabs.length]!;
    session.chooseTab(next.id);
  };
  return (
    <div class="tabs" role="tablist" aria-label="Results" onKeyDown={move}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={t.id === active} aria-controls="tab-panel" tabIndex={t.id === active ? 0 : -1} class={t.id === active ? "tab on" : "tab"} onClick={() => session.chooseTab(t.id)}>
          {t.label} <span class="count">{t.count.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

function App(props: { session: ScanSession }) {
  const { session } = props;
  const snap = useSnapshot(session);
  const [confirming, setConfirming] = useState(false);
  const [confirmingDates, setConfirmingDates] = useState<"fix" | "undo" | null>(null);
  const [confirmingTrash, setConfirmingTrash] = useState<string[] | null>(null);
  const [confirmingDuplicates, setConfirmingDuplicates] = useState(false);
  const { phase } = snap;
  const selected = session.selectedCount();
  const scanning = phase.name === "scanning";
  const creating = phase.name === "creating";
  const fixingDates = phase.name === "fixingDates";
  const trashing = phase.name === "trashing";
  const active = ScanTabs.active(snap.detectors, snap.tab);

  // Paragraph: Escape closes the topmost thing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || snap.editor) return;
      if (confirmingDuplicates) setConfirmingDuplicates(false);
      else if (confirmingTrash) setConfirmingTrash(null);
      else if (confirmingDates) setConfirmingDates(null);
      else if (confirming) setConfirming(false);
      else if (snap.confirmingClose) session.cancelClose();
      else session.requestClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [confirming, confirmingDates, confirmingTrash, confirmingDuplicates, snap.confirmingClose, phase.name, snap.editor]);

  if (snap.editor) {
    return <PanoramaEditor key={snap.editor.candidateId} session={snap.editor.session} back={{ label: "← Back", title: "Back to the scan results", onBack: () => session.closeEditor(), escape: true }} />;
  }

  return (
    <div class="app">
      <header>
        <div class="title">
          <span class="logo">✦</span>
          <h1>{snap.detectors.dates && !snap.detectors.panorama && !snap.detectors.duplicates ? "Fix dates" : "Scan library"}</h1>
        </div>
        <div class="row">
          <span class="pill" title="The scan reads this Google account">{snap.params.email}</span>
          {(scanning || creating || fixingDates || trashing || phase.name === "findingOriginals" || phase.name === "review") && <button class="btn icon small" title="Minimize: keeps running, with progress on the Pixlixir chip" aria-label="Minimize" onClick={() => session.minimize()}>–</button>}
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
                  {snap.summary && <span class="muted small"> · {snap.summary.photos.toLocaleString()} photos</span>}
                  {snap.summary && snap.summary.photosReused > 0 && <span class="muted small" title="Answered from saved results, without checking them again"> · {snap.summary.photosReused.toLocaleString()} already checked</span>}
                  {snap.elapsedSeconds !== null && <span class="muted small" title="How long this scan took"> · took {ScanEta.elapsed(snap.elapsedSeconds)}</span>}
                </span>
                {scanning || phase.name === "findingOriginals" ? <button class="btn small" onClick={() => session.stopScan()}>Stop</button> : fixingDates ? <button class="btn small" title="Stops after this batch" onClick={() => session.stopCreating()}>Stop</button> : !creating && !trashing && <button class="btn small" title="Run this scan again" onClick={() => session.scanAgain()}>Scan again</button>}
              </div>
              <Progress snap={snap} />
              {snap.scanError && <ErrorBox error={snap.scanError} />}
              <ScanFailureList snap={snap} />
          </section>

          <TabBar session={session} snap={snap} active={active} />

          {active === "panorama" && (
            <>
              {snap.summary && snap.summary.alreadyMade > 0 && <div class="muted small tab-note" title="Photos with a panorama Pixlixir already saved are not shown again. Re-check all shows them">{snap.summary.alreadyMade.toLocaleString()} already made</div>}
              <Results session={session} snap={snap} onTrash={setConfirmingTrash} />
              {snap.candidates.length > 0 && <ul class="cands">{snap.candidates.map((v) => <Candidate key={v.candidate.id} session={session} snap={snap} view={v} onTrash={setConfirmingTrash} />)}</ul>}
            </>
          )}
          {active === "duplicates" && snap.duplicates && <Duplicates session={session} snap={snap} onTrash={() => setConfirmingDuplicates(true)} />}
          {active === "dates" && (
            <>
              {snap.summary && snap.summary.unmatchedNames > 0 && <div class="muted small tab-note" title="Add their format in Settings to include them">{snap.summary.unmatchedNames.toLocaleString()} name{snap.summary.unmatchedNames === 1 ? "" : "s"} match no format</div>}
              {snap.dateFixes.length > 0 && <DateFixes session={session} snap={snap} onFix={() => setConfirmingDates("fix")} onUndo={() => setConfirmingDates("undo")} />}
            </>
          )}
          {(active === "panorama" ? snap.candidates.length : active === "dates" ? snap.dateFixes.length : (snap.duplicates?.index.links.length ?? 0)) === 0 && !scanning && !snap.scanError && <div class="muted center-text">{snap.summary ? "Nothing found." : "Stopped."}</div>}
        </div>
      )}

      {active === "panorama" && snap.candidates.length > 0 && (phase.name === "review" || creating || scanning || fixingDates || trashing) && (
        <footer>
          <button class="btn small" disabled={creating || trashing} onClick={() => session.selectAll(true)}>All</button>
          <button class="btn small" disabled={creating || trashing} onClick={() => session.selectAll(false)}>None</button>
          <div class="grow" />
          {creating ? (
            <button class="btn" onClick={() => session.stopCreating()}>Stop after this one</button>
          ) : (
            <button class="btn primary" disabled={selected === 0 || scanning || fixingDates || trashing} title={scanning ? "Available when the scan ends" : undefined} onClick={() => setConfirming(true)}>Create {selected}</button>
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

      {confirmingDuplicates && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="dups-title">
          <div class="modal card">
            <h2 id="dups-title">Move {session.duplicatesToTrash().toLocaleString()} photo{session.duplicatesToTrash() === 1 ? "" : "s"} to trash?</h2>
            <p>From <strong>{snap.params.email}</strong>. At least one photo of each group stays.</p>
            <ul class="inherit small">
              <li>The photo that stays joins their albums, and takes a description it does not have.</li>
              <li>A group with a copy in a shared album is left alone.</li>
              <li>They also leave phones with backup on.</li>
              <li>Google keeps them in Trash for 60 days (30 if not backed up), then deletes them.</li>
            </ul>
            <div class="row end">
              <button class="btn" autofocus onClick={() => setConfirmingDuplicates(false)}>Cancel</button>
              <button class="btn danger" onClick={() => { setConfirmingDuplicates(false); void session.trashDuplicates(); }}>Move to trash</button>
            </div>
          </div>
        </div>
      )}

      {confirmingTrash && (() => {
        const views = snap.candidates.filter((c) => confirmingTrash.includes(c.candidate.id));
        const photos = views.reduce((n, v) => n + ScanSession.trashableKeys(v).length, 0);
        const all = views.reduce((n, v) => n + v.candidate.items.length, 0);
        const only = views.length === 1 ? views[0]!.result : null;
        return (
          <TrashOriginalsDialog
            photos={photos}
            email={snap.params.email}
            size={only}
            staying={all - photos - views.reduce((n, v) => n + (v.result?.job.originalsTrash?.moved.length ?? 0), 0)}
            problems={views.reduce((n, v) => n + (v.result?.problems.length ?? 0), 0)}
            onCancel={() => setConfirmingTrash(null)}
            onConfirm={() => { const ids = confirmingTrash; setConfirmingTrash(null); void session.trashOriginals(ids); }}
          />
        );
      })()}

      {snap.confirmingClose && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="close-title">
          <div class="modal card">
            <h2 id="close-title">{creating ? "Stop creating panoramas?" : fixingDates ? "Stop changing dates?" : trashing ? "Stop moving to trash?" : "Stop the scan?"}</h2>
            <p>{creating ? "Panoramas already created stay in your library." : fixingDates ? "Dates already changed stay changed. Undo is lost once this closes." : trashing ? "Photos already moved stay in Google Photos’ trash." : "What it found so far will be lost."}</p>
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
