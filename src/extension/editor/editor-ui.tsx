/** Small Preact pieces shared by every editor tab. */

import { render, type ComponentChildren } from "preact";
import { useSyncExternalStore } from "preact/compat";
import { useCallback } from "preact/hooks";
import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";

/** Re-renders on every snapshot the session publishes, including any published before the page subscribed. */
export function useSnapshot<S>(session: { snapshot: S; subscribe(fn: (s: S) => void): () => void }): S {
  const subscribe = useCallback((onChange: () => void) => session.subscribe(onChange), [session]);
  return useSyncExternalStore(subscribe, () => session.snapshot);
}

export function ErrorBox(props: { error: SerializedError }) {
  return (
    <div class="error-box" role="alert" title={props.error.details ? JSON.stringify(props.error.details) : undefined}>
      <strong>{props.error.message}</strong>
      <div><code>{props.error.code}</code></div>
    </div>
  );
}

/** A row of mutually exclusive buttons. */
export function Segmented<T extends string>(props: { value: T; options: { value: T; label: string; title?: string }[]; disabled: boolean; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} title={o.title} class={`btn small ${o.value === props.value ? "on" : ""}`} role="radio" aria-checked={o.value === props.value} disabled={props.disabled} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Mounts an editor: builds the session from the URL, disposes it on page hide, shows start-up errors. */
export function bootEditor<S extends { init(): Promise<void>; dispose(): void }>(create: () => S, view: (session: S) => ComponentChildren): void {
  const root = document.getElementById("app")!;
  try {
    const session = create();
    addEventListener("pagehide", () => session.dispose());
    render(view(session), root);
    void session.init();
  } catch (err) {
    const e = err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, "Editor failed to start");
    render(<div class="center"><ErrorBox error={e.toJSON()} /></div>, root);
  }
}
