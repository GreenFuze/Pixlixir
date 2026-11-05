/** Fix feature panel (hosted by Split today, by a standalone Fix tool later): before/after, automatic fixes with sliders, and Glare / Repair / Protect brushes. */

import { useRef, useState } from "preact/hooks";
import type { Adjustments, BrushStroke, ColorMode } from "../../../imaging/enhance/adjustments.js";
import { AdjustmentPresets } from "../../../imaging/enhance/adjustments.js";
import { QuarterTurn } from "../rotation.js";
import type { FixController, FixTarget, FixView } from "./fix-controller.js";

type Tool = "none" | BrushStroke["kind"];

const TOOL_COLORS: Record<BrushStroke["kind"], string> = { glare: "#2ec5ff", repair: "#ff8a1f", protect: "#3ddc84" };
const TOOL_HELP: Record<Tool, string> = {
  none: "Pick a brush to paint on the photo.",
  glare: "Paint over glare or reflections. Detail underneath is recovered where possible.",
  repair: "Paint over scratches, creases, stains or dust to fill them from their surroundings.",
  protect: "Paint over areas that automatic fixes must not touch (e.g. a white shirt mistaken for glare).",
};

function Toggle(props: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; hint?: string | undefined }) {
  return (
    <label class="fx-toggle" title={props.hint}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function Slider(props: { label: string; value: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <label class="fx-slider">
      <span class="muted">{props.label}</span>
      <input type="range" min={0} max={1} step={0.05} value={props.value} disabled={props.disabled} onInput={(e) => props.onChange(Number((e.target as HTMLInputElement).value))} />
    </label>
  );
}

export function FixPanel(props: { controller: FixController; fix: FixView; target: FixTarget; title: string; lightingAvailable: boolean }) {
  const { controller: session, fix, target: print, title, lightingAvailable } = props;
  const adj = print.adjustments;
  const [tool, setTool] = useState<Tool>("none");
  const [brushSize, setBrushSize] = useState(0.025);
  const [comparing, setComparing] = useState(false);
  const [showMask, setShowMask] = useState(false);
  const [live, setLive] = useState<{ u: number; v: number }[] | null>(null);
  const [loaded, setLoaded] = useState(0); // re-render once the image's natural size is known
  const imgRef = useRef<HTMLImageElement>(null);

  const update = (patch: Partial<Adjustments>) => session.setAdjustments(print.id, { ...adj, ...patch });

  // Paragraph: brush painting in display coordinates, stored unrotated + normalised.
  const toNormalized = (e: PointerEvent) => {
    const r = imgRef.current!.getBoundingClientRect();
    return QuarterTurn.toUnrotated(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)), print.rotation);
  };
  const onDown = (e: PointerEvent) => {
    if (tool === "none" || !imgRef.current) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setLive([toNormalized(e)]);
  };
  const onMove = (e: PointerEvent) => {
    if (!live) return;
    const p = toNormalized(e), last = live[live.length - 1]!;
    if (Math.hypot(p.u - last.u, p.v - last.v) > brushSize * 0.25) setLive([...live, p]);
  };
  const onUp = () => {
    if (live && tool !== "none") session.addStroke(print.id, { kind: tool, radius: brushSize, points: live });
    setLive(null);
  };

  // Paragraph: stroke overlay geometry (SVG in a 1000-wide viewBox matching the displayed aspect).
  const natural = imgRef.current ? { w: imgRef.current.naturalWidth || 1, h: imgRef.current.naturalHeight || 1 } : { w: 1, h: 1 };
  const vbW = 1000, vbH = (1000 * natural.h) / natural.w, longer = Math.max(vbW, vbH);
  const pathOf = (pts: { u: number; v: number }[]) => pts.map((p) => { const d = QuarterTurn.toDisplayed(p.u, p.v, print.rotation); return `${d.x * vbW},${d.y * vbH}`; }).join(" ");
  const strokes: { kind: BrushStroke["kind"]; radius: number; points: { u: number; v: number }[]; live: boolean }[] = [
    // Committed strokes are shown (faintly) only while a brush is active, so they never hide the result.
    ...(tool !== "none" ? adj.strokes.map((s) => ({ ...s, live: false })) : []),
    ...(live && tool !== "none" ? [{ kind: tool, radius: brushSize, points: live, live: true }] : []),
  ];
  const report = fix.report;

  return (
    <div class="fx-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div class="fx">
        <header class="fx-head">
          <strong>{title}</strong>
          {fix.busy && <span class="muted small">Updating…</span>}
          <div class="grow" />
          <button class="btn icon small" title="Rotate left" aria-label="Rotate left" onClick={() => session.rotate(print.id, -1)}>⟲</button>
          <button class="btn icon small" title="Rotate right" aria-label="Rotate right" onClick={() => session.rotate(print.id, 1)}>⟳</button>
          <button class="btn primary small" onClick={() => session.closeFix()}>Done</button>
        </header>

        <div class="fx-body">
          <section class="fx-stage">
            {fix.fixedUrl ? (
              <div class={`fx-canvas ${tool !== "none" ? "painting" : ""}`} onPointerDown={(e) => onDown(e as unknown as PointerEvent)} onPointerMove={(e) => onMove(e as unknown as PointerEvent)} onPointerUp={onUp}>
                <div class="fx-frame">
                  <img ref={imgRef} src={comparing && fix.originalUrl ? fix.originalUrl : fix.fixedUrl} alt={comparing ? "Original" : "Fixed"} draggable={false} onLoad={() => setLoaded(loaded + 1)} />
                  {showMask && fix.maskUrl && !comparing && <img class="fx-overlay" src={fix.maskUrl} alt="" draggable={false} />}
                  {!comparing && (
                    <svg class="fx-overlay" viewBox={`0 0 ${vbW} ${vbH}`} preserveAspectRatio="none">
                      {strokes.map((s, i) => (
                        <polyline key={i} points={pathOf(s.points)} fill="none" stroke={TOOL_COLORS[s.kind]} stroke-opacity={s.live ? 0.5 : 0.18} stroke-width={2 * s.radius * longer} stroke-linecap="round" stroke-linejoin="round" />
                      ))}
                    </svg>
                  )}
                  {comparing && <span class="fx-badge">Original</span>}
                </div>
              </div>
            ) : (
              <div class="muted">Rendering…</div>
            )}
            <div class="fx-stagebar">
              <button class="btn small" onPointerDown={() => setComparing(true)} onPointerUp={() => setComparing(false)} onPointerLeave={() => setComparing(false)} onKeyDown={(e) => e.key === " " && setComparing(true)} onKeyUp={() => setComparing(false)}>
                Hold to compare
              </button>
              <Toggle label="Show fixed areas" hint="Highlights the areas fixed automatically" checked={showMask} onChange={setShowMask} />
            </div>
          </section>

          <aside class="fx-controls">
            <div class="fx-group">
              <Toggle label="Reduce glare automatically" checked={adj.glare.enabled} onChange={(v) => update({ glare: { ...adj.glare, enabled: v } })} hint="Only clear, bright hotspots are treated automatically. Use the Glare brush for sheen." />
              <Slider label="Sensitivity" value={adj.glare.sensitivity} disabled={!adj.glare.enabled} onChange={(v) => update({ glare: { ...adj.glare, sensitivity: v } })} />
              {report && report.glareCoverage > 0 && <div class="muted small">Treated {(report.glareCoverage * 100).toFixed(1)}%</div>}
            </div>

            <div class="fx-group">
              <Toggle label="Fix lighting & shadows" hint={lightingAvailable ? undefined : "Not available for this scan: the surface around the photos is too varied to measure the light."} checked={adj.lighting.enabled && lightingAvailable} disabled={!lightingAvailable} onChange={(v) => update({ lighting: { ...adj.lighting, enabled: v } })} />
              <Slider label="Strength" value={adj.lighting.strength} disabled={!adj.lighting.enabled || !lightingAvailable} onChange={(v) => update({ lighting: { ...adj.lighting, strength: v } })} />
            </div>

            <div class="fx-group">
              <Toggle label="Restore colour" checked={adj.color.enabled} onChange={(v) => update({ color: { ...adj.color, enabled: v } })} />
              <div class="fx-seg" role="radiogroup" aria-label="Colour mode">
                {(["restore", "preserve"] as ColorMode[]).map((m) => (
                  <button key={m} role="radio" aria-checked={adj.color.mode === m} class={`btn small ${adj.color.mode === m ? "on" : ""}`} disabled={!adj.color.enabled} onClick={() => update({ color: { ...adj.color, mode: m } })}>
                    {m === "restore" ? "Fix fading & casts" : "Keep original tones"}
                  </button>
                ))}
              </div>
              <Slider label="Strength" value={adj.color.strength} disabled={!adj.color.enabled} onChange={(v) => update({ color: { ...adj.color, strength: v } })} />
            </div>

            <div class="fx-group">
              <Toggle label="Remove dust & scratches" checked={adj.dust.enabled} onChange={(v) => update({ dust: { ...adj.dust, enabled: v } })} hint="Removes small specks and thin lines. May soften very fine detail — check with Compare." />
              <Slider label="Sensitivity" value={adj.dust.sensitivity} disabled={!adj.dust.enabled} onChange={(v) => update({ dust: { ...adj.dust, sensitivity: v } })} />
            </div>

            <div class="fx-group">
              <Toggle label="Sharpen" checked={adj.sharpen.enabled} onChange={(v) => update({ sharpen: { ...adj.sharpen, enabled: v } })} />
              <Slider label="Amount" value={adj.sharpen.amount} disabled={!adj.sharpen.enabled} onChange={(v) => update({ sharpen: { ...adj.sharpen, amount: v } })} />
            </div>

            <div class="fx-group">
              <div class="fx-seg" role="radiogroup" aria-label="Brush">
                {(["none", "glare", "repair", "protect"] as Tool[]).map((t) => (
                  <button key={t} role="radio" aria-checked={tool === t} title={TOOL_HELP[t]} class={`btn small ${tool === t ? "on" : ""}`} style={t !== "none" ? { borderColor: TOOL_COLORS[t] } : undefined} onClick={() => setTool(t)}>
                    {t === "none" ? "No brush" : t[0]!.toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              <label class="fx-slider">
                <span class="muted">Brush size</span>
                <input type="range" min={0.005} max={0.08} step={0.005} value={brushSize} onInput={(e) => setBrushSize(Number((e.target as HTMLInputElement).value))} />
              </label>
              <div class="row">
                <button class="btn small" disabled={adj.strokes.length === 0} onClick={() => session.undoStroke(print.id)}>Undo stroke</button>
                <button class="btn small" disabled={adj.strokes.length === 0} onClick={() => update({ strokes: [] })}>Clear brushes</button>
              </div>
            </div>

            <div class="fx-group">
              {session.applySettingsToAll && <button class="btn small" onClick={() => session.applySettingsToAll!(print.id)}>Use these settings for all photos</button>}
              <div class="row">
                <button class="btn small" onClick={() => session.setAdjustments(print.id, { ...AdjustmentPresets.auto(), strokes: adj.strokes })}>Reset to auto</button>
                <button class="btn small" onClick={() => session.setAdjustments(print.id, { ...AdjustmentPresets.none(), strokes: [] })}>No fixes</button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
