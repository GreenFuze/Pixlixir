/** Side panel: the contextual command center for the active Google Photos tab. */

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { LIVE_CAPABILITIES } from "../../gphotos/capabilities.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { Messenger, type PanelState } from "../messaging/protocol.js";
import { JobStore, type SplitJob } from "../storage/job-store.js";

/** Actions shown for context but not yet built — labelled honestly. */
const PLANNED = ["Restore damaged photo", "Edit with AI", "Find duplicates", "Fix date & location", "Create panorama"];

class PanelModel {
  async load(): Promise<{ state: PanelState; jobs: SplitJob[] }> {
    const win = await chrome.windows.getCurrent();
    if (win.id === undefined) throw new PixError(ErrorCode.Internal, "No current window");
    const state = await Messenger.toBackground({ type: "panel.getState", windowId: win.id });
    const store = await JobStore.open();
    try {
      return { state, jobs: await store.recent(8) };
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
  const [data, setData] = useState<{ state: PanelState; jobs: SplitJob[] } | null>(null);
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
  const single = items.length === 1 && items[0]!.type !== "video" ? items[0]! : null;

  const openSplit = async () => {
    if (!tab || !single) return;
    try {
      await Messenger.toBackground({ type: "panel.openSplitEditor", tabId: tab.tabId, mediaKey: single.mediaKey });
    } catch (err) {
      setError((err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not open editor")).toJSON());
    }
  };

  return (
    <div class="panel">
      <header><span class="logo">✦</span> <strong>Pixlixir</strong></header>

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
            <div>{items.length === 0 ? <span class="muted">Nothing selected. Select or open a photo.</span> : `${items.length} item${items.length === 1 ? "" : "s"} selected`}</div>
            <div class="actions">
              <button class="btn primary" disabled={!single || !tab?.account} onClick={() => void openSplit()}>Split into Photos</button>
              {!single && <span class="muted small">Works on exactly one photo (e.g. a scanned album page).</span>}
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
              const saved = j.prints.filter((p) => p.saved).length;
              return (
                <li key={j.id}>
                  <div>Split {j.sourceFileName ?? "scan"}</div>
                  <div class="muted small">{j.accountEmail} · {saved}/{j.prints.filter((p) => p.included).length} saved · <span class={`pill ${j.status === "done" ? "ok" : j.status === "failed" ? "danger" : ""}`}>{j.status}</span></div>
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
