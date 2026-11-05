/** Settings page: the filename formats the date check knows, for one Google account at a time. */

import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { FilenameFormat, FilenameFormats, type FilenameFormatEntry } from "../../scan/filename-format.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { ErrorBox } from "../editor/editor-ui.js";
import { Messenger } from "../messaging/protocol.js";
import { FormatStore } from "../storage/format-store.js";

const MASK_HELP = "yyyy mm dd hh mm ss are the date. * is any text, ? is any one character. Example: IMG-yyyymmdd.*";
const failure = (err: unknown): SerializedError => (err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Settings failed")).toJSON();

function maskProblem(mask: string, list: readonly FilenameFormatEntry[]): string | null {
  if (mask.trim() === "") return null;
  if (list.some((e) => e.mask.toLowerCase() === mask.trim().toLowerCase())) return "Already in the list.";
  try {
    new FilenameFormat({ mask, utc: false });
    return null;
  } catch (err) {
    return err instanceof PixError ? err.message : "Not a valid format.";
  }
}

function TryName(props: { entries: FilenameFormatEntry[] }) {
  const [name, setName] = useState("");
  const parser = useMemo(() => new FilenameFormats(props.entries), [props.entries]);
  const stamp = name.trim() ? parser.parse(name.trim()) : null;
  const when = stamp ? new Date(stamp.localMs).toISOString().slice(0, stamp.hasTime ? 19 : 10).replace("T", " ") : null;
  return (
    <section class="card">
      <label class="field-row">
        <strong>Try a file name</strong>
        <input value={name} placeholder="IMG-20240328.jpg" spellcheck={false} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      {name.trim() && (stamp
        ? <div class="try-result"><span class="pill ok">{when}{stamp.utc ? " UTC" : ""}</span> <code>{stamp.mask}</code></div>
        : <div class="try-result"><span class="pill warn">No match</span></div>)}
    </section>
  );
}

function Formats(props: { email: string }) {
  const store = useMemo(() => new FormatStore(props.email), [props.email]);
  const [entries, setEntries] = useState<FilenameFormatEntry[] | null>(null);
  const [mask, setMask] = useState("");
  const [utc, setUtc] = useState(false);
  const [error, setError] = useState<SerializedError | null>(null);

  // Paragraph: this account's list.
  useEffect(() => {
    setEntries(null);
    store.load().then(setEntries, (err: unknown) => setError(failure(err)));
  }, [store]);

  const update = async (next: FilenameFormatEntry[]) => {
    try {
      await store.save(next);
      setEntries(next);
      setError(null);
    } catch (err) {
      setError(failure(err));
    }
  };

  if (!entries) return error ? <ErrorBox error={error} /> : <div class="muted">Loading…</div>;
  const problem = maskProblem(mask, entries);
  const missingDefaults = FilenameFormats.DEFAULTS.filter((d) => !entries.some((e) => e.mask === d.mask));

  const add = async (e: Event) => {
    e.preventDefault();
    if (mask.trim() === "" || problem) return;
    await update([{ mask: mask.trim(), utc }, ...entries]);
    setMask("");
    setUtc(false);
  };

  return (
    <>
      {error && <ErrorBox error={error} />}
      <section class="card">
        <form class="add-row" onSubmit={(e) => void add(e)}>
          <input aria-label="New format" title={MASK_HELP} value={mask} placeholder="IMG-yyyymmdd.*" spellcheck={false} onInput={(e) => setMask((e.target as HTMLInputElement).value)} />
          <label class="opt small" title="The time in the name is UTC, as on Pixel phones"><input type="checkbox" checked={utc} onChange={() => setUtc(!utc)} /> UTC</label>
          <button class="btn primary" disabled={mask.trim() === "" || problem !== null}>Add</button>
        </form>
        {problem && <div class="err small" role="alert">{problem}</div>}
      </section>

      <section class="card">
        <div class="list-head">
          <strong>Formats ({entries.length})</strong>
          {missingDefaults.length > 0 && <button class="btn small" title="Add back the formats Pixlixir started with" onClick={() => void update([...entries, ...missingDefaults])}>Restore defaults</button>}
        </div>
        {entries.length === 0 && <div class="muted small">No formats: the date check finds nothing.</div>}
        <ul class="formats">
          {entries.map((entry) => (
            <li key={entry.mask}>
              <code>{entry.mask}</code>
              <label class="opt small" title="The time in the name is UTC, as on Pixel phones">
                <input type="checkbox" checked={entry.utc} onChange={() => void update(entries.map((x) => (x === entry ? { ...x, utc: !x.utc } : x)))} /> UTC
              </label>
              <button class="btn icon small" aria-label={`Delete ${entry.mask}`} title="Delete" onClick={() => void update(entries.filter((x) => x !== entry))}>✕</button>
            </li>
          ))}
        </ul>
      </section>

      <TryName entries={entries} />
    </>
  );
}

function App() {
  const given = new URLSearchParams(location.search).get("email");
  const [accounts, setAccounts] = useState<string[] | null>(given ? [given] : null);
  const [email, setEmail] = useState<string | null>(given);
  const [error, setError] = useState<SerializedError | null>(null);

  // Paragraph: opened from Chrome's menu, the page learns the accounts from the open Photos tabs.
  useEffect(() => {
    if (given) return;
    Messenger.toBackground({ type: "panel.accounts" }).then((r) => {
      setAccounts(r.emails);
      setEmail(r.emails[0] ?? null);
    }, (err: unknown) => setError(failure(err)));
  }, []);

  return (
    <main class="settings">
      <header>
        <span class="logo">✦</span>
        <h1>Filename formats</h1>
        {accounts && accounts.length > 1
          ? <select aria-label="Account" title="Each Google account has its own list" value={email ?? ""} onChange={(e) => setEmail((e.target as HTMLSelectElement).value)}>{accounts.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          : email && <span class="pill" title="Each Google account has its own list">{email}</span>}
      </header>
      {error && <ErrorBox error={error} />}
      {accounts && accounts.length === 0 && <div class="muted">Open <a href="https://photos.google.com" target="_blank" rel="noreferrer">Google Photos</a>, then reload this page.</div>}
      {email && <Formats key={email} email={email} />}
    </main>
  );
}

render(<App />, document.getElementById("app")!);
