/** The Upscale panel: a before/after preview of one area, the settings, and Apply (ADR-0010). */

import { ErrorBox, Segmented } from "../editor-ui.js";
import { UpscaleController, type UpscaleView } from "./upscale-controller.js";
import type { UpscaleDevice } from "./ort-upscale-model.js";
import type { UpscaleFactor } from "../../../imaging/upscale/upscaler.js";

export interface UpscaleActions {
  chooseUpscale(patch: Partial<Pick<UpscaleView, "factor" | "smooth" | "device" | "point">>): void;
  applyUpscale(): Promise<void>;
  closeUpscale(): void;
}

export function UpscalePanel(props: { actions: UpscaleActions; view: UpscaleView; photoUrl: string; size: { width: number; height: number } }) {
  const { actions, view, size } = props;
  const running = view.busy === "run";
  const tooBig = (f: UpscaleFactor) => `${(size.width * f).toLocaleString()} × ${(size.height * f).toLocaleString()}`;

  // Paragraph: where the preview square sits on the overview, in percent.
  const side = UpscaleController.PREVIEW_SIDE;
  const boxW = Math.min(100, (side / size.width) * 100), boxH = Math.min(100, (side / size.height) * 100);
  const left = Math.max(0, Math.min(100 - boxW, view.point.u * 100 - boxW / 2)), top = Math.max(0, Math.min(100 - boxH, view.point.v * 100 - boxH / 2));
  const pick = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    actions.chooseUpscale({ point: { u: (e.clientX - r.left) / r.width, v: (e.clientY - r.top) / r.height } });
  };

  return (
    <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="upscale-title">
      <div class="modal card upscale-modal">
        <div class="row between">
          <h2 id="upscale-title">Upscale</h2>
          <button class="btn small" disabled={running} onClick={() => actions.closeUpscale()}>Close</button>
        </div>

        <div class="upscale-body">
          <div class="upscale-overview" title="Click where to look closer" onClick={(e) => !running && pick(e as unknown as MouseEvent)}>
            <img src={props.photoUrl} alt="The photo" draggable={false} />
            <div class="upscale-box" style={{ left: `${left}%`, top: `${top}%`, width: `${boxW}%`, height: `${boxH}%` }} />
          </div>
          <div class="upscale-compare">
            <figure title="Enlarged the plain way">
              {view.preview ? <img src={view.preview.beforeUrl} alt="Before" /> : <div class="upscale-empty" />}
              <figcaption class="muted small">Before</figcaption>
            </figure>
            <figure title={view.preview ? `Made in ${(view.preview.ms / 1000).toFixed(1)} s` : undefined}>
              {view.preview ? <img src={view.preview.afterUrl} alt="After" class={view.busy === "preview" ? "stale" : ""} /> : <div class="upscale-empty">{view.busy ? "…" : ""}</div>}
              <figcaption class="muted small">After</figcaption>
            </figure>
          </div>
        </div>

        <div class="row upscale-controls">
          <Segmented<`${UpscaleFactor}`> label="Size" value={`${view.factor}`} disabled={running} onChange={(v) => actions.chooseUpscale({ factor: Number(v) as UpscaleFactor })}
            options={([2, 4] as const).map((f) => ({ value: `${f}` as const, label: `${f}×`, title: view.fits[f] ? tooBig(f) : `${tooBig(f)} is too large` }))} />
          <label class="opt grow" title="Left keeps film grain and noise; right smooths them away">
            <span class="muted">Smooth</span>
            <input type="range" aria-label="Smooth" min={0} max={1} step={0.05} value={view.smooth} disabled={running} onInput={(e) => actions.chooseUpscale({ smooth: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <Segmented<UpscaleDevice> label="Device" value={view.device} disabled={running || view.gpu === null} onChange={(v) => actions.chooseUpscale({ device: v })}
            options={[{ value: "gpu", label: "GPU", title: view.gpu === false ? "No GPU is available to this browser" : "Fast" }, { value: "cpu", label: "CPU", title: "Much slower; for when the GPU fails" }]} />
        </div>

        {view.error && <ErrorBox error={view.error} />}

        <div class="row end">
          {running && <span class="muted">{view.progress ? `${Math.round((100 * view.progress.done) / view.progress.total)}%` : "Starting…"}</span>}
          {!running && !view.fits[view.factor] && <span class="pill warn">Too large</span>}
          <button class="btn primary" title={`Enlarge the whole photo to ${tooBig(view.factor)}. Nothing is saved yet`} disabled={view.busy !== null || !view.fits[view.factor] || (view.device === "gpu" && !view.gpu)} onClick={() => void actions.applyUpscale()}>Apply</button>
        </div>
      </div>
    </div>
  );
}
