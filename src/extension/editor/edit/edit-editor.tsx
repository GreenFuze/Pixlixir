/** Edit with AI: brush, text and buttons, then a dialog that waits for the result (ADR-0009), and the built-in fixes. */

import { useEffect, useRef, useState } from "preact/hooks";
import { ErrorBox, useSnapshot } from "../editor-ui.js";
import { FixPanel } from "../fix/fix-panel.js";
import { InheritanceList } from "../panorama/panorama-ui.js";
import type { SignIn } from "./ai-services.js";
import { EDIT_PRESETS } from "./edit-presets.js";
import type { EditFill, EditSession } from "./edit-session.js";
import { ResultInput } from "./result-input.js";
import { UpscalePanel } from "../upscale/upscale-panel.js";

const BRUSH_COLOR = "#ff00ff";
const SIGN_IN_MARK: Record<SignIn, string> = { in: "● ", out: "○ ", unknown: "" };
const SIGN_IN_NOTE: Record<SignIn, string> = { in: "", out: " (sign in)", unknown: "" };
const FILL_FAILED_HELP: Record<Extract<EditFill, { state: "failed" }>["step"], string> = {
  box: "The site's message box was not found. Sign in if it asks, then paste the picture and prompt yourself",
  picture: "The site did not take the picture. It is copied: paste it yourself, then the prompt",
  text: "The site did not take the prompt. Copy it and paste it yourself",
  send: "The picture and prompt are there, but send could not be pressed. Press it yourself",
  refused: "Chrome was not allowed to work on this site. The picture is copied: paste it yourself, then the prompt",
  site: "The site could not be reached. The picture is copied: paste it yourself, then the prompt",
};

function FillStatus(props: { fill: EditFill }) {
  const { fill } = props;
  if (fill.state === "working") return <span class="pill">Filling…</span>;
  if (fill.state === "sent") return <span class="pill ok">Sent</span>;
  if (fill.state === "filled") return <span class="pill ok" title="The picture and prompt are in the site's box">Press Send there</span>;
  if (fill.state === "failed") return <span class="pill warn" title={FILL_FAILED_HELP[fill.step]}>{fill.step === "send" ? "Press Send there" : "Paste it yourself"}</span>;
  return null;
}

function BrushStage(props: { session: EditSession }) {
  const { session } = props;
  const snap = useSnapshot(session);
  const [live, setLive] = useState<{ u: number; v: number }[] | null>(null);
  const [radius, setRadius] = useState(0.03);
  const [comparing, setComparing] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const size = snap.size ?? { width: 1, height: 1 };

  // Paragraph: painting in normalised photo coordinates.
  const at = (e: PointerEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { u: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), v: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: PointerEvent) => {
    if (snap.phase.name !== "ready" || !img.current) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setLive([at(e)]);
  };
  const move = (e: PointerEvent) => {
    if (!live) return;
    const p = at(e), last = live[live.length - 1]!;
    if (Math.hypot(p.u - last.u, p.v - last.v) > radius * 0.25) setLive([...live, p]);
  };
  const up = () => {
    if (live) session.addBrushStroke({ kind: "repair", radius, points: live });
    setLive(null);
  };

  // Paragraph: strokes as an overlay in a 1000-wide box of the photo's shape.
  const boxW = 1000, boxH = (1000 * size.height) / size.width, longer = Math.max(boxW, boxH);
  const line = (points: { u: number; v: number }[]) => points.map((p) => `${p.u * boxW},${p.v * boxH}`).join(" ");
  const strokes = [...snap.strokes, ...(live ? [{ radius, points: live }] : [])];

  return (
    <section class="stage edit-stage">
      {snap.shownUrl && (
        <div class="edit-frame" onPointerDown={(e) => down(e as unknown as PointerEvent)} onPointerMove={(e) => move(e as unknown as PointerEvent)} onPointerUp={up}>
          <img ref={img} src={comparing && snap.previousUrl ? snap.previousUrl : snap.shownUrl} alt="The photo" draggable={false} />
          {!comparing && (
            <svg class="edit-overlay" viewBox={`0 0 ${boxW} ${boxH}`} preserveAspectRatio="none" aria-hidden="true">
              {strokes.map((s, i) => (
                <polyline key={i} points={line(s.points.length === 1 ? [s.points[0]!, s.points[0]!] : s.points)} fill="none" stroke={BRUSH_COLOR} stroke-opacity={0.5} stroke-width={2 * s.radius * longer} stroke-linecap="round" stroke-linejoin="round" />
              ))}
            </svg>
          )}
        </div>
      )}
      <div class="row edit-brushbar">
        <label class="opt small" title="Brush size. A brush is optional: text alone is enough"><span aria-hidden="true">●</span><input type="range" aria-label="Brush size" min={0.005} max={0.12} step={0.005} value={radius} onInput={(e) => setRadius(Number((e.target as HTMLInputElement).value))} /></label>
        <button class="btn small" title="Remove the last stroke" disabled={snap.strokes.length === 0} onClick={() => session.undoBrushStroke()}>Undo stroke</button>
        <button class="btn small" title="Remove all of the brush" disabled={snap.strokes.length === 0} onClick={() => session.clearStrokes()}>Delete brush</button>
        {snap.previousUrl && <button class="btn small" title="Hold to see the version before" onPointerDown={() => setComparing(true)} onPointerUp={() => setComparing(false)} onPointerLeave={() => setComparing(false)}>Compare</button>}
        {snap.previousUrl && <button class="btn small" title="Go back one version" disabled={snap.phase.name === "saving"} onClick={() => session.undoVersion()}>Undo edit</button>}
      </div>
    </section>
  );
}

function Handover(props: { session: EditSession }) {
  const { session } = props;
  const snap = useSnapshot(session);
  const h = snap.handover!;
  const service = snap.services.find((s) => s.id === snap.serviceId);
  const [address, setAddress] = useState("");
  const [over, setOver] = useState(false);

  // Paragraph: while waiting, a paste anywhere on the page counts, unless typing the address.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || !e.clipboardData) return;
      e.preventDefault();
      void session.bringBack(ResultInput.read(e.clipboardData));
    };
    addEventListener("paste", onPaste);
    return () => removeEventListener("paste", onPaste);
  }, [session]);

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="handover-title">
      <div class="modal card edit-modal">
        <div class="row between">
          <h2 id="handover-title">{service?.name ?? "Service"}</h2>
          <button class="btn small" onClick={() => session.closeHandover()}>Close</button>
        </div>

        <div class="edit-send">
          <img src={h.sentUrl} alt="The picture to send" title={`${h.width} × ${h.height} px, without its details such as location`} />
          <div class="col">
            {h.engine ? (
              <div class="row">
                <button class="btn small" disabled={h.adding} onClick={() => session.sendAgain()}>Run again</button>
              </div>
            ) : (
              <div class="row">
                <button class="btn small" title="Opens the site again and fills it again" disabled={h.fill.state === "working"} onClick={() => session.sendAgain()}>Open {service?.name}</button>
                <button class="btn small" onClick={() => void session.copyPicture()}>Copy picture</button>
                <button class="btn small" title={h.prompt} onClick={() => void session.copyPrompt()}>Copy prompt</button>
              </div>
            )}
            <div class="row">
              <FillStatus fill={h.fill} />
              {h.copied && <span class="pill ok">{h.copied === "picture" ? "Picture copied" : "Prompt copied"}</span>}
            </div>
            <p class="small edit-prompt">{h.engine ? snap.text : h.prompt}</p>
          </div>
        </div>

        <div
          class={`edit-drop ${over ? "over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            if (e.dataTransfer) void session.bringBack(ResultInput.read(e.dataTransfer));
          }}
        >
          <strong>Paste or drop the result here</strong>
          <div class="row">
            <input aria-label="Picture address" placeholder="https://…" value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} />
            <button class="btn small" disabled={address.trim() === "" || h.adding} onClick={() => { void session.bringBack([{ kind: "url", url: address.trim() }]); setAddress(""); }}>Add</button>
            <label class="btn small">Files…<input type="file" accept="image/*" multiple hidden onChange={(e) => { const input = e.target as HTMLInputElement; void session.bringBack([...(input.files ?? [])].map((blob) => ({ kind: "image" as const, blob }))); input.value = ""; }} /></label>
          </div>
          {h.adding && <span class="muted small">{h.engine ? "Working…" : "Reading…"}</span>}
        </div>

        {h.error && <ErrorBox error={h.error} />}

        {h.candidates.length > 0 && (
          <ul class="edit-results">
            {h.candidates.map((c) => (
              <li key={c.id}>
                <img src={c.previewUrl} alt="A result" />
                <div class="row">
                  <span class="pill" title="Size of the photo with this result">{c.width.toLocaleString()} × {c.height.toLocaleString()}</span>
                  {c.fit && !c.fit.linesUp && <span class="pill warn" title="This result does not match the photo around the brush, so the pasted area may look wrong">Doesn't line up</span>}
                  {!h.region && snap.size && c.width * c.height < snap.size.width * snap.size.height && <span class="pill warn" title="The service returned fewer pixels than the photo has">Smaller</span>}
                  <div class="grow" />
                  <button class="btn small" title="Keep it on this computer. Nothing goes to Google Photos" onClick={() => void session.downloadCandidate(c.id)}>Download</button>
                  <button class="btn primary small" title="Keep working on it here. Nothing is saved yet" onClick={() => void session.useCandidate(c.id)}>Use</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SaveDialog(props: { session: EditSession }) {
  const { session } = props;
  const snap = useSnapshot(session);
  const draft = snap.saveDraft!;
  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="save-title">
      <div class="modal card">
        <h2 id="save-title">Save as a new photo?</h2>
        <p>In <strong>{snap.params.email}</strong>. The original stays as it is.</p>
        {draft.status === "loading" && <div class="muted">Reading the photo’s details…</div>}
        {draft.status === "failed" && <ErrorBox error={draft.error} />}
        {draft.status === "ready" && <InheritanceList inherited={draft.inherited} matchDate={true} addToAlbums={true} copyDescription={true} />}
        <div class="row end">
          <button class="btn" onClick={() => session.cancelSave()}>Cancel</button>
          <button class="btn primary" disabled={draft.status !== "ready"} onClick={() => { if (draft.status === "ready") void session.save({ matchDate: true, albums: draft.inherited.albums, copyDescription: true }); }}>Save</button>
        </div>
      </div>
    </div>
  );
}

export function EditEditor(props: { session: EditSession }) {
  const { session } = props;
  const snap = useSnapshot(session);
  const { phase, presetId, text, services, serviceId, signIn, published, params } = snap;
  const editable = phase.name === "ready" || phase.name === "saved";
  const chosen = services.find((s) => s.id === serviceId);
  const unknown = services.some((s) => signIn[s.id] === "unknown" && s.signedInCookies);
  const ordered = [...services].sort((a, b) => Number(signIn[b.id] === "in") - Number(signIn[a.id] === "in"));

  return (
    <div class="app edit-editor">
      <header>
        <div class="title">
          <button class="btn small" title="Close this tab. Your photo stays as it is." disabled={phase.name === "saving"} onClick={() => window.close()}>Close</button>
          <span class="logo">✦</span>
          <h1>Edit</h1>
          {snap.item?.fileName && <span class="muted">{snap.item.fileName}</span>}
        </div>
        <span class="pill" title="A saved edit goes to this Google account">{params.email}</span>
      </header>

      {phase.name === "failed" ? <div class="center"><ErrorBox error={phase.error} /></div> : phase.name === "loading" ? <div class="center muted">{phase.step}</div> : (
        <main>
          <BrushStage session={session} />
          <aside>
            <div class="edit-presets" role="radiogroup" aria-label="What to do">
              {EDIT_PRESETS.map((p) => (
                <button key={p.id} role="radio" aria-checked={p.id === presetId} title={p.title} class={`btn small ${p.id === presetId ? "on" : ""}`} disabled={!editable} onClick={() => session.choosePreset(p.id)}>{p.label}</button>
              ))}
            </div>
            <textarea class="edit-text" rows={4} aria-label="Instruction" placeholder="What should change?" disabled={!editable} value={text} onInput={(e) => session.setText((e.target as HTMLTextAreaElement).value)} />
            {session.needsTarget() && <span class="pill warn" title="Brush it, or say what in the text, such as: remove the crowd">Brush it or describe it</span>}

            <label class="col small">
              <span class="muted" title="Choose the model on the site, or add a service with its own address in Settings">Service</span>
              <select aria-label="Service" value={serviceId} disabled={!editable} onChange={(e) => session.chooseService((e.target as HTMLSelectElement).value)}>
                {ordered.map((s) => <option key={s.id} value={s.id}>{SIGN_IN_MARK[signIn[s.id] ?? "unknown"]}{s.name}{SIGN_IN_NOTE[signIn[s.id] ?? "unknown"]}</option>)}
              </select>
            </label>
            {unknown && <button class="btn small" title="Asks Chrome to let Pixlixir see whether you are signed in. Only cookie names are looked at, never their values" onClick={() => void session.checkSignIn()}>Check sign-in</button>}

            {chosen?.engine && (
              <div class="col small">
                <div class="row between">
                  <span class="muted" title="The models on your server. Add or remove them there, then press Refresh">Model</span>
                  <span class="row">
                    <button class="btn small" title="Read the server's models again" disabled={snap.engineBusy} onClick={() => void session.loadModels()}>Refresh</button>
                    <a class="btn small" href={chosen.url} target="_blank" rel="noreferrer" title="The server's own screen, for anything not here">Open UI ↗</a>
                  </span>
                </div>
                <select aria-label="Model" value={snap.engineModels?.current ?? ""} disabled={!editable || snap.engineBusy || !snap.engineModels} onChange={(e) => void session.chooseModel((e.target as HTMLSelectElement).value)}>
                  {!snap.engineModels?.current && <option value="">{snap.engineBusy ? "Reading…" : "Unknown"}</option>}
                  {snap.engineModels?.list.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                </select>
                {session.needsBrush() && <span class="pill warn" title="This model fills a brushed area from its surroundings, and cannot read text. Brush it, or choose a model that follows text">Needs a brush</span>}
                {session.hasStrength() && <label class="opt" title="How far it may stray from the picture"><span class="muted">Strength</span><input type="range" aria-label="Strength" min={0.1} max={1} step={0.05} value={snap.strength} onInput={(e) => session.setStrength(Number((e.target as HTMLInputElement).value))} /></label>}
              </div>
            )}

            {!chosen?.engine && <label class="opt small" title="Off: Pixlixir fills the site's box and you press send"><input type="checkbox" checked={snap.autoSend} disabled={!editable} onChange={(e) => session.setAutoSend((e.target as HTMLInputElement).checked)} />Send automatically</label>}

            <button class="btn primary" disabled={!session.canSend()} onClick={() => session.send()}>Send</button>
            <button class="btn" title="Glare, colour, dust and sharpening, on this computer. Nothing is sent" disabled={!editable || snap.fix !== null} onClick={() => void session.openAutoFix()}>Auto fix</button>
            <button class="btn" title="More pixels, with detail drawn in by a model on this computer. Nothing is sent" disabled={!editable || snap.upscale !== null} onClick={() => session.openUpscale()}>Upscale</button>
            {snap.notice && <ErrorBox error={snap.notice} />}
          </aside>
        </main>
      )}

      {(phase.name === "ready" || phase.name === "saving" || phase.name === "saved") && (
        <footer>
          {phase.name === "saving" && <span class="muted">{phase.step}</span>}
          {published && <a class="pill ok" href={published.created.webUrl} target="_blank" rel="noreferrer">Saved</a>}
          {published?.problems.map((p, i) => <span key={i} class="pill warn" title={p.code}>{p.message}</span>)}
          <div class="grow" />
          <button class="btn" disabled={phase.name === "saving" || snap.versions < 2} title={snap.versions < 2 ? "Make an edit first" : "Keep it on this computer. Nothing goes to Google Photos"} onClick={() => void session.downloadCurrent()}>Download</button>
          <button class="btn primary" disabled={phase.name !== "ready" || snap.versions < 2} title={snap.versions < 2 ? "Make an edit first" : "Upload it to Google Photos as a new item"} onClick={() => void session.prepareSave()}>Save as new</button>
        </footer>
      )}

      {snap.handover && <Handover session={session} />}
      {snap.fix && snap.fixTarget && <FixPanel controller={session} fix={snap.fix} target={snap.fixTarget} title="Auto fix" lightingAvailable={false} />}
      {snap.upscale && snap.shownUrl && snap.size && <UpscalePanel actions={session} view={snap.upscale} photoUrl={snap.shownUrl} size={snap.size} />}
      {snap.saveDraft && <SaveDialog session={session} />}
    </div>
  );
}
