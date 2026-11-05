/** Side panel: the contextual command center for the active Google Photos tab. */

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { LIVE_CAPABILITIES } from "../../gphotos/capabilities.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { Messenger, type PanelState } from "../messaging/protocol.js";
import { JobStore, type PixJob } from "../storage/job-store.js";
import { SCAN_HINT, ToolEligibility, TOOL_IDS, TOOLS, type ToolId } from "../tools.js";

/** Actions shown for context but not yet built — labelled honestly. */
const PLANNED = ["Fix a photo (restore, lighting, colour)", "Edit with AI", "Find duplicates", "Fix location", "HDR / focus stacking"];

class PanelModel {
  async load(): Promise<{ state: PanelState; jobs: PixJob[] }> {
    const win = await chrome.windows.getCurrent();
    if (win.id === undefined) throw new PixError(ErrorCode.Internal, "No current window");
    const state = await Messenger.toBackground({ type: "panel.getState", windowId: win.id });

    // Paragraph: recent work of the account in the active Photos tab only.
    const account = state.activeTab?.account?.email;
    if (!account) return { state, jobs: [] };
    const store = await JobStore.open();
    try {
      return { state, jobs: await store.recent(account, 12) };
    } finally {
      store.close();
    }
  }

  subscribe(onChange: () => void): () => void {
    const fire = () => onChange();
    chrome.tabs.onActivated.addListener(fire);
    chrome.tabs.onUpdated.addListener(fire);
    chrome.storage.session.onChanged.addListener(fire);
    const timer = setInterval(fire, 5000); // job progress written by editor tabs
    return () => {
      chrome.tabs.onActivated.removeListener(fire);
      chrome.tabs.onUpdated.removeListener(fire);
      chrome.storage.session.onChanged.removeListener(fire);
      clearInterval(timer);
    };
  }
}

function App(props: { model: PanelModel }) {
  const [data, setData] = useState<{ state: PanelState; jobs: PixJob[] } | null>(null);
  const [error, setError] = useState<SerializedError | null>(null);

  useEffect(() => {
    const refresh = () =>
      props.model.load().then(
        (d) => { setData(d); setError(null); },
        (err: unknown) => setError((err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Panel failed")).toJSON()),
      );
    void refresh();
    return props.model.subscribe(() => void refresh());
  }, []);

  const tab = data?.state.activeTab ?? null;
  const sel = tab?.selection;
  const items = sel?.kind === "grid" ? sel.items : sel?.kind === "viewer" ? [sel.item] : [];
  const eligible = TOOL_IDS.map((tool) => ({ tool, keys: ToolEligibility.mediaKeys(tool, items) }));

  const openTool = async (tool: ToolId, mediaKeys: string[]) => {
    if (!tab) return;
    try {
      await Messenger.toBackground({ type: "panel.openTool", tool, tabId: tab.tabId, mediaKeys });
    } catch (err) {
      setError((err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not open editor")).toJSON());
    }
  };

  const photoKeys = items.filter((i) => i.type !== "video").map((i) => i.mediaKey);
  const openScan = async () => {
    if (!tab) return;
    try {
      await Messenger.toBackground({ type: "panel.openScan", tabId: tab.tabId, mediaKeys: photoKeys.length > 1 ? photoKeys : [] });
    } catch (err) {
      setError((err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not open the scan")).toJSON());
    }
  };

  const openSettings = async () => {
    try {
      if (tab?.account) await Messenger.toBackground({ type: "panel.openSettings", tabId: tab.tabId });
      else await chrome.runtime.openOptionsPage();
    } catch (err) {
      setError((err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not open settings")).toJSON());
    }
  };

  return (
    <div class="panel">
      <header>
        <span class="logo">✦</span> <strong>Pixlixir</strong>
        <button class="btn icon small settings-btn" title="Settings" aria-label="Settings" onClick={() => void openSettings()}>⚙</button>
      </header>

      {error && <div class="error-box" role="alert">{error.message} <code>{error.code}</code></div>}

      {data && !data.state.activeIsPhotos && (
        <section class="card">
          <p>Open <a href="https://photos.google.com" target="_blank" rel="noreferrer">Google Photos</a> in this window to use Pixlixir.</p>
        </section>
      )}

      {data?.state.activeIsPhotos && (
        <>
          <section class="card">
            <div class="label">Account</div>
            {tab?.account ? (
              <div><strong>{tab.account.email}</strong>{tab.account.authUserIndex > 0 && <span class="muted"> · /u/{tab.account.authUserIndex}</span>}</div>
            ) : tab?.sessionError ? (
              <div class="error-box">{tab.sessionError.message}</div>
            ) : (
              <div class="muted">Detecting… reload the Photos tab if this persists.</div>
            )}
          </section>

          <section class="card">
            <div class="label">Selection</div>
            <div>{items.length === 0 ? <span class="muted">Nothing selected</span> : `${items.length} item${items.length === 1 ? "" : "s"} selected`}</div>
            {eligible.map(({ tool, keys }) => (
              <div class="actions" key={tool}>
                <button class="btn primary" title={keys ? undefined : TOOLS[tool].hint} disabled={!keys || !tab?.account} onClick={() => keys && void openTool(tool, keys)}>{TOOLS[tool].label}</button>
              </div>
            ))}
          </section>

          <section class="card">
            <div class="actions">
              <button class="btn" title={SCAN_HINT} disabled={!tab?.account} onClick={() => void openScan()}>{photoKeys.length > 1 ? `Scan ${photoKeys.length} selected…` : "Scan library…"}</button>
            </div>
            <details class="planned">
              <summary class="muted small">Planned actions</summary>
              <ul>{PLANNED.map((p) => <li key={p} class="muted small">{p} — not available yet</li>)}</ul>
            </details>
          </section>
        </>
      )}

      {data && data.jobs.length > 0 && (
        <section class="card">
          <div class="label">Recent work</div>
          <ul class="jobs">
            {data.jobs.map((j) => {
              const status = <span class={`pill ${j.status === "done" ? "ok" : j.status === "failed" ? "danger" : ""}`}>{j.status}</span>;
              if (j.kind === "panorama") {
                return (
                  <li key={j.id}>
                    <div>Panorama of {j.sourceMediaKeys.length} photos{j.batchId ? <span class="muted small"> · from a scan</span> : null}</div>
                    <div class="muted small">{j.saved ? <a href={j.saved.webUrl} target="_blank" rel="noreferrer">open ↗</a> : "not saved"} · {status}</div>
                  </li>
                );
              }
              if (j.kind === "dateFix") {
                return (
                  <li key={j.id}>
                    <div>Dates fixed</div>
                    <div class="muted small">{j.changes.filter((c) => c.applied).length}/{j.changes.length} · {status}</div>
                  </li>
                );
              }
              const saved = j.prints.filter((p) => p.saved).length;
              return (
                <li key={j.id}>
                  <div>Split {j.sourceFileName ?? "scan"}</div>
                  <div class="muted small">{saved}/{j.prints.filter((p) => p.included).length} saved · {status}</div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <details class="card caps">
        <summary class="label">What works today</summary>
        <ul>
          {LIVE_CAPABILITIES.map((c) => (
            <li key={c.id}><span class={`pill ${c.status === "live-verified" ? "ok" : c.status === "blocked" ? "danger" : "warn"}`}>{c.status}</span> {c.label}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

render(<App model={new PanelModel()} />, document.getElementById("app")!);
