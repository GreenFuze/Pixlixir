/**
 * Base for editor-tab controllers (Split, Panorama, …): snapshot + subscribers,
 * URL parameters, the bound Photos tab, and uniform failure reporting.
 */

import { ErrorCode, PixError, type SerializedError } from "../../shared/errors.js";
import { Messenger } from "../messaging/protocol.js";

export interface EditorParams {
  /** The Photos tab that opened the editor (preferred, but any tab of the same account works). */
  tabId: number;
  email: string;
  mediaKeys: string[];
}

export abstract class EditorSession<S extends { phase: unknown }> {
  #snap: S;
  readonly #listeners = new Set<(s: S) => void>();

  protected constructor(initial: S) {
    this.#snap = initial;
  }

  /** Parses ?tab=&email=&media=k1,k2 and enforces how many photos this editor accepts. */
  static parseParams(search: string, count: { min: number; max: number }): EditorParams {
    const q = new URLSearchParams(search);
    const tabId = Number(q.get("tab"));
    const email = q.get("email") ?? "";
    const mediaKeys = (q.get("media") ?? "").split(",").filter((k) => k.length > 0);
    const valid = Number.isInteger(tabId) && email.includes("@") && mediaKeys.every((k) => k.length >= 10) && mediaKeys.length >= count.min && mediaKeys.length <= count.max;
    if (!valid) {
      throw new PixError(ErrorCode.InvalidMessage, "The editor was opened without a valid photo reference.", { tabId, hasEmail: email.length > 0, photos: mediaKeys.length, expected: count });
    }
    return { tabId, email, mediaKeys };
  }

  get snapshot(): S {
    return this.#snap;
  }

  subscribe(fn: (s: S) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  protected set(patch: Partial<S>): void {
    this.#snap = { ...this.#snap, ...patch };
    for (const fn of this.#listeners) fn(this.#snap);
  }

  /** A live Photos tab signed in as `email` (never another account). */
  protected async photosTab(email: string, preferredTabId: number): Promise<number> {
    return (await Messenger.toBackground({ type: "photos.resolveTab", email, preferredTabId })).tabId;
  }

  protected static toError(err: unknown, fallback = "Unexpected failure"): PixError {
    return err instanceof PixError ? err : PixError.wrap(err, ErrorCode.Internal, fallback);
  }

  /** Logs and moves the editor into its failed phase. */
  protected fail(err: unknown): void {
    const e = EditorSession.toError(err);
    console.error("[pixlixir]", e.toJSON());
    this.set({ phase: { name: "failed", error: e.toJSON() } } as unknown as Partial<S>);
  }

  protected static failure(err: unknown): SerializedError {
    return EditorSession.toError(err).toJSON();
  }
}
