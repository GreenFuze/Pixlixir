/** Settings page, for one Google account at a time: the filename formats the date check knows, and the AI services Edit can use. */

import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { FilenameFormat, FilenameFormats, type FilenameFormatEntry } from "../../scan/filename-format.js";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { BUILT_IN_SERVICES, ServiceStore, type AiService } from "../editor/edit/ai-services.js";
import { ENGINE_KINDS, EngineCommands, LocalAddress, type EngineDevice, type EngineKind } from "../editor/edit/local-engines.js";
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
              <label class="opt small" title="The date in the name is when the file was saved, not taken, so it is never suggested">
                <input type="checkbox" checked={entry.saved === true} onChange={() => void update(entries.map((x) => (x === entry ? { ...x, saved: x.saved !== true } : x)))} /> Saved
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

/** AI services for Edit: the built-in ones, plus any the user adds by address (a service, or one of its models). */
function Services(props: { email: string }) {
  const store = useMemo(() => new ServiceStore(props.email), [props.email]);
  const [added, setAdded] = useState<AiService[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<SerializedError | null>(null);
  const reload = () => store.load().then((s) => setAdded(s.added), (err: unknown) => setError(failure(err)));

  // Paragraph: this account's added services.
  useEffect(() => {
    void reload();
  }, [store]);

  const add = async (e: Event) => {
    e.preventDefault();
    try {
      await store.add(name, url);
      setName("");
      setUrl("");
      setError(null);
      await reload();
    } catch (err) {
      setError(failure(err));
    }
  };

  return (
    <section class="card">
      <div class="list-head"><strong title="Where Edit sends a picture. Add a site, or the address of one of its models">AI services</strong></div>
      {error && <ErrorBox error={error} />}
      <ul class="formats">
        {BUILT_IN_SERVICES.map((s) => <li key={s.id}><code>{s.name}</code></li>)}
        {added.map((s) => (
          <li key={s.id}>
            <code title={s.url}>{s.name}</code>
            <button class="btn icon small" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => void store.remove(s.id).then(reload, (err: unknown) => setError(failure(err)))}>✕</button>
          </li>
        ))}
      </ul>
      <form class="add-row" onSubmit={(e) => void add(e)}>
        <input aria-label="Service name" value={name} placeholder="Name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <input aria-label="Service address" value={url} placeholder="https://…" spellcheck={false} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        <button class="btn primary" aria-label="Add service" disabled={name.trim() === "" || url.trim() === ""}>Add</button>
      </form>
    </section>
  );
}

/** One command to copy. */
function CommandRow(props: { label: string; title: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <li>
      <span class="muted" title={props.title}>{props.label}</span>
      <code>{props.command}</code>
      <button class="btn small" onClick={() => void navigator.clipboard.writeText(props.command).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
    </li>
  );
}

/** Commands to start a server and get a model: a browser extension cannot run them. */
function EngineSetup(props: { kind: EngineKind; address: string }) {
  const { kind, address } = props;
  const info = ENGINE_KINDS.find((k) => k.id === kind)!;
  const [device, setDevice] = useState<EngineDevice>("cuda");
  const [model, setModel] = useState("lama");

  // Paragraph: the commands, or why they cannot be made yet.
  let commands: { start: string; download: string | null } | null = null;
  let problem: string | null = null;
  try {
    commands = { start: EngineCommands.start(kind, device, model, LocalAddress.parse(address)), download: EngineCommands.download(kind, model) };
  } catch (err) {
    problem = failure(err).message;
  }

  return (
    <div class="engine-setup">
      <div class="add-row">
        <select aria-label="Device" title="CUDA needs an NVIDIA graphics card and PyTorch's CUDA build" value={device} onChange={(e) => setDevice((e.target as HTMLSelectElement).value as EngineDevice)}>
          <option value="cuda">CUDA</option>
          <option value="cpu">CPU</option>
        </select>
        {kind === "iopaint" && <input aria-label="Model to run" title="A name from IOPaint's model list, or a model id on Hugging Face" value={model} spellcheck={false} onInput={(e) => setModel((e.target as HTMLInputElement).value)} />}
      </div>
      {problem && <div class="err">{problem}</div>}
      {commands && (
        <ul class="formats">
          <CommandRow label="Start" title="Run this in the folder where it is installed, and leave it running" command={commands.start} />
          {commands.download && <CommandRow label="Download" title="Adds this model to the server. Then press Refresh in Edit" command={commands.download} />}
        </ul>
      )}
      <div class="muted small" title={info.modelFiles}>Add or delete models</div>
    </div>
  );
}

/** Local engines for Edit: servers the user runs themselves, by kind and address. */
function Engines(props: { email: string }) {
  const store = useMemo(() => new ServiceStore(props.email), [props.email]);
  const [engines, setEngines] = useState<AiService[]>([]);
  const [kind, setKind] = useState<EngineKind>("iopaint");
  const [name, setName] = useState("");
  const [address, setAddress] = useState(ENGINE_KINDS[0]!.address);
  const [error, setError] = useState<SerializedError | null>(null);
  const reload = () => store.load().then((s) => setEngines(s.engines), (err: unknown) => setError(failure(err)));

  // Paragraph: this account's engines.
  useEffect(() => {
    void reload();
  }, [store]);

  const add = async (e: Event) => {
    e.preventDefault();
    try {
      // Paragraph: the address is checked first, so Chrome is only asked about a real one.
      const clean = LocalAddress.parse(address);
      if (!(await LocalAddress.request(clean))) throw new PixError(ErrorCode.InvalidService, "Permission to reach that address was refused", { address: clean });
      await store.addEngine(name, clean, kind);
      setName("");
      setError(null);
      await reload();
    } catch (err) {
      setError(failure(err));
    }
  };

  return (
    <section class="card">
      <div class="list-head"><strong title="Image servers you run yourself. The picture goes only to the address you give, and a result reaches Google Photos only if you save it">Local engines</strong></div>
      {error && <ErrorBox error={error} />}
      <ul class="formats engine-kinds" aria-label="Supported engines">
        {ENGINE_KINDS.map((k) => (
          <li key={k.id}>
            <strong title={k.help}>{k.label}</strong>
            <span class="engine-links">
              {[...k.runtimes, ...k.models].map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer" title={link.title}>{link.name} ↗</a>)}
            </span>
          </li>
        ))}
      </ul>
      {engines.length > 0 && (
        <ul class="formats" aria-label="Your engines">
          {engines.map((s) => (
            <li key={s.id}>
              <code title={s.url}>{s.name}</code>
              <a href={s.url} target="_blank" rel="noreferrer" title="The server's own screen">Open UI ↗</a>
              <button class="btn icon small" aria-label={`Delete ${s.name}`} title="Delete" onClick={() => void store.remove(s.id).then(reload, (err: unknown) => setError(failure(err)))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <form class="add-row" onSubmit={(e) => void add(e)}>
        <select aria-label="Engine kind" value={kind} onChange={(e) => { const k = (e.target as HTMLSelectElement).value as EngineKind; setKind(k); setAddress(ENGINE_KINDS.find((x) => x.id === k)!.address); }}>
          {ENGINE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
        <input aria-label="Engine name" value={name} placeholder="Name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <input aria-label="Engine address" value={address} spellcheck={false} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} />
        <button class="btn primary" aria-label="Add engine" disabled={name.trim() === "" || address.trim() === ""}>Add</button>
      </form>
      <EngineSetup key={kind} kind={kind} address={address} />
    </section>
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
        <h1>Settings</h1>
        {accounts && accounts.length > 1
          ? <select aria-label="Account" title="Each Google account has its own list" value={email ?? ""} onChange={(e) => setEmail((e.target as HTMLSelectElement).value)}>{accounts.map((a) => <option key={a} value={a}>{a}</option>)}</select>
          : email && <span class="pill" title="Each Google account has its own list">{email}</span>}
      </header>
      {error && <ErrorBox error={error} />}
      {accounts && accounts.length === 0 && <div class="muted">Open <a href="https://photos.google.com" target="_blank" rel="noreferrer">Google Photos</a>, then reload this page.</div>}
      {email && <Formats key={email} email={email} />}
      {email && <Services key={`services-${email}`} email={email} />}
      {email && <Engines key={`engines-${email}`} email={email} />}
    </main>
  );
}

render(<App />, document.getElementById("app")!);
