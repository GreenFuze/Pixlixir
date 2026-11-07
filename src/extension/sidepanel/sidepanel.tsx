/** Side panel: the contextual command center for the active Google Photos tab. */

import { h, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { Messenger, type PanelState } from "../messaging/protocol.js";
import { JobStore, type PixJob } from "../storage/job-store.js";
import { FixDatesTool, ToolEligibility, TOOL_IDS, TOOLS, type ToolId } from "../tools.js";
import { TOOL_ICONS, ToolIcon, type ToolIconId } from "../ui/tool-icons.js";
import { BulkOperations } from "./bulk-operations.js";

/** A picture of what the tool does, with a one-word caption; the full name is the tooltip. */
function ToolButton(props: { icon: ToolIconId; caption: string; title: string; disabled: boolean; onClick: () => void }) {
  return (
    <button class="tool-btn" title={props.title} aria-label={props.title} disabled={props.disabled} onClick={props.onClick}>
      {h("svg", { viewBox: ToolIcon.VIEW_BOX, "aria-hidden": "true" }, TOOL_ICONS[props.icon].map((shape, i) => h(shape.tag, { key: i, ...shape.attrs })))}
      <span>{props.caption}</span>
    </button>
  );
}

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

  const datesPlan = FixDatesTool.plan(items);
  const fixDates = async () => {
    if (!tab || !datesPlan) return;
    try {
      await Messenger.toBackground({ type: "panel.openScan", tabId: tab.tabId, plan: datesPlan });
    } catch (err) {
      setError((err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Could not start fixing dates")).toJSON());
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
        {tab?.account && <span class="pill account" title={tab.account.authUserIndex > 0 ? `Google account /u/${tab.account.authUserIndex}` : "The Google account of this tab"}>{tab.account.email}</span>}
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
          {tab?.sessionError && <div class="error-box">{tab.sessionError.message}</div>}
          {!tab?.account && !tab?.sessionError && <div class="muted small" title="Reload the Photos tab if this persists">Detecting the account…</div>}

          <section class="card">
            <div class="label">{items.length === 0 ? "Selected photos" : `${items.length} selected`}</div>
            <div class="tools">
              {eligible.map(({ tool, keys }) => (
                <ToolButton key={tool} icon={tool} caption={TOOLS[tool].short} title={keys ? TOOLS[tool].label : TOOLS[tool].hint} disabled={!keys || !tab?.account} onClick={() => keys && void openTool(tool, keys)} />
              ))}
              <ToolButton icon="dates" caption={FixDatesTool.SHORT} title={datesPlan ? FixDatesTool.LABEL : FixDatesTool.HINT} disabled={!datesPlan || !tab?.account} onClick={() => void fixDates()} />
            </div>
          </section>

          {tab?.account && <BulkOperations key={tab.account.email} tabId={tab.tabId} email={tab.account.email} selection={items.map((i) => i.mediaKey)} albumKey={data.state.albumKey} activity={tab.activity ?? null} />}
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
              if (j.kind === "duplicateTrash") {
                return (
                  <li key={j.id}>
                    <div>Duplicates moved to trash</div>
                    <div class="muted small">{j.moved.length}/{j.dedupKeys.length} · {status}</div>
                  </li>
                );
              }
              if (j.kind === "edit") {
                return (
                  <li key={j.id}>
                    <div title={j.steps.map((s) => s.prompt ? `${s.by}: ${s.prompt}` : s.by).join("\n")}>Edit of {j.sourceFileName ?? "a photo"}</div>
                    <div class="muted small">{j.saved ? <a href={j.saved.webUrl} target="_blank" rel="noreferrer">open ↗</a> : "not saved"} · {status}</div>
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
    </div>
  );
}

render(<App model={new PanelModel()} />, document.getElementById("app")!);
