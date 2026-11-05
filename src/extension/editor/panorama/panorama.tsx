/** Create-panorama editor view. */

import { useState } from "preact/hooks";
import type { Edges, Motion, Projection, Straighten } from "../../../imaging/panorama/stitch-runtime.js";
import { bootEditor, ErrorBox, Segmented, useSnapshot } from "../editor-ui.js";
import { PanoramaSession, type PanoramaQuality, type PanoramaSnapshot, type PanoramaSource } from "./panorama-session.js";
import { InheritanceList } from "./panorama-ui.js";

const PROJECTIONS: { value: Projection; label: string; hint: string }[] = [
  { value: "spherical", label: "Spherical", hint: "Best default: wide and multi-row panoramas, up to 360°." },
  { value: "cylindrical", label: "Cylindrical", hint: "Single-row wide panoramas; keeps verticals straight." },
  { value: "perspective", label: "Perspective", hint: "Keeps straight lines straight; only for narrower views (under ~120°)." },
  { value: "panini", label: "Panini", hint: "Wide interiors and architecture with less stretching at the sides." },
  { value: "mercator", label: "Mercator", hint: "Like cylindrical, with less vertical stretching near top and bottom." },
  { value: "fisheye", label: "Fisheye", hint: "Strongly curved, fisheye-lens look." },
  { value: "stereographic", label: "Stereographic", hint: "Very wide fields of view with round distortion." },
];

const STRAIGHTEN: { value: Straighten; label: string }[] = [
  { value: "horizontal", label: "Horizontal pan" },
  { value: "vertical", label: "Vertical pan" },
  { value: "auto", label: "Automatic" },
  { value: "off", label: "Off" },
];

const QUALITY: { value: PanoramaQuality; label: string }[] = [
  { value: "max", label: `Maximum (≤ ${PanoramaSession.QUALITY_MEGAPIXELS.max} MP)` },
  { value: "large", label: `Large (≤ ${PanoramaSession.QUALITY_MEGAPIXELS.large} MP)` },
  { value: "medium", label: `Medium (≤ ${PanoramaSession.QUALITY_MEGAPIXELS.medium} MP)` },
];

function SourceRow(props: { session: PanoramaSession; snap: PanoramaSnapshot; source: PanoramaSource; index: number }) {
  const { session, snap, source, index } = props;
  const p = snap.preview;
  const status =
    source.status === "failed" ? <span class="err">{source.error?.message ?? "Could not load"}</span>
    : source.status !== "ready" ? <span class="muted small">{source.status === "downloading" ? "Downloading…" : "Waiting…"}</span>
    : !source.included ? <span class="pill">Left out</span>
    : p?.dropped.includes(source.key) ? <span class="pill warn" title="No overlap with the other photos was found">Not connected</span>
    : p?.used.includes(source.key) ? <span class="pill ok">In panorama</span>
    : <span class="muted small">…</span>;
  return (
    <li class="src">
      <div class="thumb">{source.thumbUrl ? <img src={source.thumbUrl} alt={`Photo ${index + 1}`} /> : <span class="muted small">{index + 1}</span>}</div>
      <div class="meta">
        <div class="small" title={source.item?.fileName ?? ""}>{source.item?.fileName ?? `Photo ${index + 1}`}</div>
        <div class="row">{status}</div>
        {source.downscaled && <div class="muted small">Reduced to fit in memory ({source.size?.width}×{source.size?.height}).</div>}
        <label class="inc">
          <input type="checkbox" checked={source.included} disabled={source.status !== "ready" || snap.phase.name !== "ready"} onChange={() => session.toggleSource(source.key)} />
          Include
        </label>
      </div>
    </li>
  );
}

function Stage(props: { session: PanoramaSession; snap: PanoramaSnapshot; showFill: boolean }) {
  const { session, snap, showFill } = props;
  const p = snap.preview;
  return (
    <section class="stage pano-stage" aria-busy={snap.previewBusy}>
      {p && (
        <div class="pano-frame">
          <img src={p.url} alt="Panorama preview" />
          {showFill && p.fillUrl && <img class="pano-overlay" src={p.fillUrl} alt="" />}
        </div>
      )}
      {!p && !snap.previewBusy && snap.previewError && (
        <div class="pano-msg">
          <ErrorBox error={snap.previewError} />
          <button class="btn" onClick={() => session.retryPreview()}>Try again</button>
        </div>
      )}
      {snap.previewBusy && <div class="pano-busy" aria-live="polite">{snap.progress ?? "Stitching…"}</div>}
    </section>
  );
}

function App(props: { session: PanoramaSession }) {
  const { session } = props;
  const snap = useSnapshot(session);
  const [matchDate, setMatchDate] = useState(true);
  const [addToAlbums, setAddToAlbums] = useState(true);
  const [copyDescription, setCopyDescription] = useState(true);
  const draft = snap.saveDraft;
  const [showFill, setShowFill] = useState(true);
  const { phase, settings, preview: p, params } = snap;
  const editable = phase.name === "ready";
  const estimate = session.estimatedOutput();
  const included = session.includedKeys().length;
  const projectionHint = PROJECTIONS.find((x) => x.value === settings.projection)?.hint;

  return (
    <div class="app">
      <header>
        <div class="title">
          <span class="logo">✦</span>
          <h1>Create panorama</h1>
          <span class="muted">{params.mediaKeys.length} photos</span>
        </div>
        <span class="pill" title="The panorama is saved to this Google account">Account: <strong>{params.email}</strong></span>
      </header>

      {phase.name === "loading" && <div class="center muted" aria-live="polite">{phase.step}{snap.progress ? ` · ${snap.progress}` : ""}</div>}
      {phase.name === "failed" && <div class="center"><ErrorBox error={phase.error} /></div>}

      {phase.name !== "loading" && phase.name !== "failed" && (
        <main>
          <Stage session={session} snap={snap} showFill={showFill} />
          <aside>
            <section class="group">
              <strong>How were the photos taken?</strong>
              <Segmented<Motion> label="Camera motion" value={settings.motion} disabled={!editable} onChange={(motion) => session.setSettings({ motion })}
                options={[{ value: "rotate", label: "Turning in place" }, { value: "flat", label: "Moving over a flat surface" }]} />
              <div class="muted small">{settings.motion === "rotate" ? "Landscapes, rooms, multi-row and 360° shots." : "Posters, maps, whiteboards, documents or album pages photographed in parts."}</div>
            </section>

            {settings.motion === "rotate" && (
              <section class="group">
                <label class="field">
                  <span>Projection</span>
                  <select value={settings.projection} disabled={!editable} onChange={(e) => session.setSettings({ projection: (e.target as HTMLSelectElement).value as Projection })}>
                    {PROJECTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <div class="muted small">{projectionHint}</div>
                <label class="field">
                  <span>Straighten horizon</span>
                  <select value={settings.straighten} disabled={!editable} onChange={(e) => session.setSettings({ straighten: (e.target as HTMLSelectElement).value as Straighten })}>
                    {STRAIGHTEN.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
              </section>
            )}

            <section class="group">
              <strong>Edges</strong>
              <Segmented<Edges> label="Edges" value={settings.edges} disabled={!editable} onChange={(edges) => session.setSettings({ edges })}
                options={[{ value: "crop", label: "Crop to rectangle" }, { value: "fill", label: "Fill edges" }]} />
              {settings.edges === "fill" && (
                <>
                  <div class="note">Filled areas are <strong>made up</strong> from nearby pixels{p ? ` (${(p.filledFraction * 100).toFixed(1)}% of the image)` : ""}. They are not real photo content.</div>
                  <label class="opt small"><input type="checkbox" checked={showFill} onChange={() => setShowFill(!showFill)} /> Show filled areas</label>
                </>
              )}
            </section>

            <section class="group">
              <label class="opt"><input type="checkbox" checked={settings.tryHarder} disabled={!editable} onChange={() => session.setSettings({ tryHarder: !settings.tryHarder })} /> Try harder to connect photos</label>
              <div class="muted small">Slower; accepts weaker matches. Use it when a photo shows “Not connected”.</div>
            </section>

            <section class="group">
              <strong>Saved size</strong>
              <select value={snap.quality} disabled={!editable} onChange={(e) => session.setQuality((e.target as HTMLSelectElement).value as PanoramaQuality)} aria-label="Saved size">
                {QUALITY.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {estimate && <div class="muted small">About {estimate.width.toLocaleString()} × {estimate.height.toLocaleString()} px ({((estimate.width * estimate.height) / 1e6).toFixed(1)} MP){estimate.capped ? ", reduced to the size limit" : ", full resolution"}.</div>}
            </section>

            <section class="group">
              <strong>Photos ({included} included)</strong>
              <ul class="srcs">{snap.sources.map((s, i) => <SourceRow key={s.key} session={session} snap={snap} source={s} index={i} />)}</ul>
            </section>
          </aside>
        </main>
      )}

      {(phase.name === "ready" || phase.name === "saving" || phase.name === "saved") && (
        <footer>
          {p && <span class="muted small">Preview {p.width}×{p.height} · {p.seconds.toFixed(1)} s</span>}
          <div class="grow" />
          <span class="muted">Your photos are never changed.</span>
          <button class="btn" disabled={!p || phase.name === "saving"} onClick={() => void session.download()}>Download</button>
          {phase.name === "saving" ? (
            <button class="btn primary" disabled>{snap.progress ?? phase.step}</button>
          ) : phase.name === "saved" && snap.job?.saved ? (
            <span class="row">
              <span class="pill ok">Saved to Google Photos</span>
              {snap.published && snap.published.albumsAdded.length > 0 && <span class="muted small">Added to {snap.published.albumsAdded.length} album{snap.published.albumsAdded.length > 1 ? "s" : ""}</span>}
              {snap.published?.problems.map((pr, i) => <span key={i} class="err">{pr.message}</span>)}
              <a href={snap.job.saved.webUrl} target="_blank" rel="noreferrer">Open in Google Photos ↗</a>
            </span>
          ) : (
            <button class="btn primary" disabled={!p || snap.previewBusy} onClick={() => void session.prepareSave()}>Save to Google Photos</button>
          )}
        </footer>
      )}

      {draft && (
        <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div class="modal card">
            <h2 id="confirm-title">Save this panorama?</h2>
            <p>
              It will be built at full size{estimate ? ` (about ${estimate.width.toLocaleString()} × ${estimate.height.toLocaleString()} px)` : ""} and uploaded as a <strong>new item</strong> to <strong>{params.email}</strong>.
              Your {p?.used.length ?? included} photos stay exactly as they are.
              {settings.edges === "fill" && " It includes filled-in (made-up) edges."}
            </p>
            {draft.status === "loading" && <p class="muted">Reading the photos’ date, location and albums…</p>}
            {draft.status === "failed" && <ErrorBox error={draft.error} />}
            {draft.status === "ready" && (
              <>
                <strong class="small">It takes over from your photos:</strong>
                <InheritanceList inherited={draft.inherited} matchDate={matchDate} addToAlbums={addToAlbums} copyDescription={copyDescription} />
                <div class="col">
                  <label class="opt small"><input type="checkbox" checked={matchDate} onChange={() => setMatchDate(!matchDate)} /> Use the earliest photo’s date</label>
                  {draft.inherited.albums.length > 0 && <label class="opt small"><input type="checkbox" checked={addToAlbums} onChange={() => setAddToAlbums(!addToAlbums)} /> Add it to the same albums</label>}
                  {draft.inherited.description && <label class="opt small"><input type="checkbox" checked={copyDescription} onChange={() => setCopyDescription(!copyDescription)} /> Copy the description</label>}
                </div>
              </>
            )}
            <div class="row end">
              <button class="btn" onClick={() => session.cancelSave()}>Cancel</button>
              <button class="btn primary" autofocus disabled={draft.status !== "ready"}
                onClick={() => draft.status === "ready" && void session.save({ matchDate, albums: addToAlbums ? draft.inherited.albums : [], copyDescription })}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

bootEditor(() => new PanoramaSession(PanoramaSession.paramsFromUrl(location.search)), (session) => <App session={session} />);
