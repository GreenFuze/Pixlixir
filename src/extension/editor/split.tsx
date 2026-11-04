/** Split-into-Photos editor view. */

import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Point, Quad } from "../../imaging/geometry.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import type { SplitPrintRecord } from "../storage/job-store.js";
import { SplitSession, type Snapshot } from "./split-session.js";

const COLORS = ["#7b4dff", "#00a2ff", "#ff7a00", "#00b37e", "#ff3d7f", "#c2a600"];

function useSnapshot(session: SplitSession): Snapshot {
  const [snap, setSnap] = useState(session.snapshot);
  useEffect(() => session.subscribe(setSnap), [session]);
  return snap;
}

// ---- canvas with editable quads ------------------------------------------------

type Drag = { id: string; corner: number | null; start: Point; original: Quad };

function QuadCanvas(props: { snap: Snapshot; session: SplitSession }) {
  const { snap, session } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [live, setLive] = useState<{ id: string; quad: Quad } | null>(null);
  const size = snap.imageSize!;
  const handleR = Math.max(size.width, size.height) / 90;

  // Paragraph: client -> image coordinates.
  const toImage = (e: PointerEvent): Point => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: Math.max(0, Math.min(size.width, p.x)), y: Math.max(0, Math.min(size.height, p.y)) };
  };

  // Paragraph: drag corner or whole quad.
  const onDown = (e: PointerEvent, print: SplitPrintRecord, corner: number | null) => {
    if (print.saved) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    session.select(print.id);
    setDrag({ id: print.id, corner, start: toImage(e), original: print.quad });
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const p = toImage(e);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    const quad = drag.original.map((c, i) => (drag.corner === null || drag.corner === i ? { x: c.x + dx, y: c.y + dy } : c)) as Quad;
    setLive({ id: drag.id, quad });
  };
  const onUp = () => {
    if (drag && live) session.updateQuad(live.id, live.quad);
    setDrag(null);
    setLive(null);
  };

  const prints = snap.job?.prints ?? [];
  return (
    <svg
      ref={svgRef}
      class="canvas"
      viewBox={`0 0 ${size.width} ${size.height}`}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerDown={() => session.select(null)}
      role="img"
      aria-label="Scan with detected photos. Drag corners to adjust."
    >
      <image href={snap.imageUrl!} x={0} y={0} width={size.width} height={size.height} />
      {prints.map((p, i) => {
        const quad = live?.id === p.id ? live.quad : p.quad;
        const color = COLORS[i % COLORS.length]!;
        const selected = snap.selectedId === p.id;
        const pts = quad.map((c) => `${c.x},${c.y}`).join(" ");
        const cx = quad.reduce((s, c) => s + c.x, 0) / 4, cy = quad.reduce((s, c) => s + c.y, 0) / 4;
        return (
          <g key={p.id} opacity={p.included ? 1 : 0.35}>
            <polygon
              points={pts}
              fill={color}
              fill-opacity={selected ? 0.22 : 0.1}
              stroke={color}
              stroke-width={handleR * (selected ? 0.45 : 0.3)}
              style={{ cursor: p.saved ? "default" : "move" }}
              onPointerDown={(e) => onDown(e as unknown as PointerEvent, p, null)}
            />
            <text x={cx} y={cy} fill="#fff" stroke="#000" stroke-width={handleR * 0.12} font-size={handleR * 3} text-anchor="middle" dominant-baseline="middle" pointer-events="none">
              {p.saved ? `✓${i + 1}` : i + 1}
            </text>
            {selected && !p.saved &&
              quad.map((c, ci) => (
                <circle key={ci} cx={c.x} cy={c.y} r={handleR} fill="#fff" stroke={color} stroke-width={handleR * 0.35} style={{ cursor: "grab" }} onPointerDown={(e) => onDown(e as unknown as PointerEvent, p, ci)} />
              ))}
          </g>
        );
      })}
    </svg>
  );
}

// ---- sidebar -----------------------------------------------------------------------

function PrintCard(props: { session: SplitSession; snap: Snapshot; print: SplitPrintRecord; index: number }) {
  const { session, snap, print, index } = props;
  const preview = snap.previews[print.id];
  const lowConfidence = print.confidence !== null && print.confidence < 0.6;
  const busy = snap.phase.name === "saving";
  return (
    <li class={`print ${snap.selectedId === print.id ? "selected" : ""}`} style={{ borderInlineStartColor: COLORS[index % COLORS.length] }} onClick={() => session.select(print.id)}>
      <div class="thumb">{preview ? <img src={preview} alt={`Preview of photo ${index + 1}`} /> : <span class="muted">…</span>}</div>
      <div class="meta">
        <div class="row">
          <strong>Photo {index + 1}</strong>
          {print.saved && <span class="pill ok">Saved</span>}
          {!print.saved && lowConfidence && <span class="pill warn" title="The detected outline may be imprecise — check its corners.">Check edges</span>}
        </div>
        {print.saved ? (
          <a href={print.saved.webUrl} target="_blank" rel="noreferrer">Open in Google Photos ↗</a>
        ) : (
          <div class="row">
            <button class="btn icon small" title="Rotate left" aria-label="Rotate left" disabled={busy} onClick={(e) => { e.stopPropagation(); session.rotate(print.id, -1); }}>⟲</button>
            <button class="btn icon small" title="Rotate right" aria-label="Rotate right" disabled={busy} onClick={(e) => { e.stopPropagation(); session.rotate(print.id, 1); }}>⟳</button>
            <label class="inc" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={print.included} disabled={busy} onChange={() => session.toggleIncluded(print.id)} /> Include
            </label>
            <button class="btn icon small danger" title="Remove this outline" aria-label="Remove" disabled={busy} onClick={(e) => { e.stopPropagation(); session.remove(print.id); }}>✕</button>
          </div>
        )}
        {print.error && <div class="err">{print.error.message}</div>}
      </div>
    </li>
  );
}

function ErrorBox(props: { error: SerializedError }) {
  return (
    <div class="error-box" role="alert">
      <strong>{props.error.message}</strong>
      <div><code>{props.error.code}</code></div>
    </div>
  );
}

// ---- app ------------------------------------------------------------------------------

function App(props: { session: SplitSession }) {
  const { session } = props;
  const snap = useSnapshot(session);
  const [confirming, setConfirming] = useState(false);
  const [matchDate, setMatchDate] = useState(true);
  const { phase, job, item, params } = snap;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && snap.selectedId && phase.name === "ready") session.remove(snap.selectedId);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [snap.selectedId, phase.name]);

  const pending = job?.prints.filter((p) => p.included && !p.saved) ?? [];
  const savedCount = job?.prints.filter((p) => p.saved).length ?? 0;

  return (
    <div class="app">
      <header>
        <div class="title">
          <span class="logo">✦</span>
          <h1>Split into Photos</h1>
          {item?.fileName && <span class="muted">{item.fileName}</span>}
        </div>
        <span class="pill" title="All changes go to this Google account">Account: <strong>{params.email}</strong></span>
      </header>

      {phase.name === "loading" && <div class="center muted" aria-live="polite">{phase.step}</div>}
      {phase.name === "failed" && <div class="center"><ErrorBox error={phase.error} /></div>}

      {snap.imageSize && job && phase.name !== "failed" && phase.name !== "loading" && (
        <main>
          <section class="stage">
            <QuadCanvas snap={snap} session={session} />
          </section>
          <aside>
            {snap.resumed && <div class="note">Resumed your earlier split of this scan{savedCount > 0 ? ` (${savedCount} already saved)` : ""}.</div>}
            <div class="row between">
              <strong>{job.prints.length} photo{job.prints.length === 1 ? "" : "s"} found</strong>
              <button class="btn small" disabled={phase.name === "saving"} onClick={() => session.addPrint()}>+ Add photo</button>
            </div>
            {job.prints.length === 0 && <p class="muted">No photos were detected. Use “Add photo” and drag the corners around each picture.</p>}
            <ul class="prints">
              {job.prints.map((p, i) => <PrintCard key={p.id} session={session} snap={snap} print={p} index={i} />)}
            </ul>
          </aside>
        </main>
      )}

      {job && (phase.name === "ready" || phase.name === "saving" || phase.name === "finished") && (
        <footer>
          <label class="opt">
            <input type="checkbox" checked={matchDate} disabled={phase.name !== "ready"} onChange={() => setMatchDate(!matchDate)} />
            Use the scan’s date (keeps the photos next to it in your timeline)
          </label>
          <div class="grow" />
          <span class="muted">The original scan is never changed.</span>
          <button class="btn" disabled={phase.name === "saving" || pending.length === 0} onClick={() => void session.downloadAll()}>Download</button>
          {phase.name === "saving" ? (
            <button class="btn primary" disabled>Saving {phase.done}/{phase.total}…</button>
          ) : phase.name === "finished" ? (
            <span class="pill ok">All {savedCount} photos saved to Google Photos</span>
          ) : (
            <button class="btn primary" disabled={pending.length === 0} onClick={() => setConfirming(true)}>
              Save {pending.length} to Google Photos
            </button>
          )}
        </footer>
      )}

      {confirming && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="modal card">
            <h2 id="confirm-title">Save {pending.length} new photo{pending.length === 1 ? "" : "s"}?</h2>
            <p>They will be uploaded as <strong>new items</strong> to <strong>{params.email}</strong>{matchDate ? ", dated like the original scan" : ""}. The original scan stays exactly as it is.</p>
            <div class="row end">
              <button class="btn" onClick={() => setConfirming(false)}>Cancel</button>
              <button class="btn primary" autofocus onClick={() => { setConfirming(false); void session.save(matchDate); }}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- boot -----------------------------------------------------------------------------------

const root = document.getElementById("app")!;
try {
  const session = new SplitSession(SplitSession.paramsFromUrl(location.search));
  addEventListener("pagehide", () => session.dispose());
  render(<App session={session} />, root);
  void session.init();
} catch (err) {
  const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Editor failed to start");
  render(<div class="center"><ErrorBox error={e.toJSON()} /></div>, root);
}
