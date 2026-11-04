/**
 * Google Photos web-session context.
 *
 * PRIVATE PROTOCOL: everything here depends on undocumented page globals.
 * The tokens read here (XSRF `at`, `f.sid`) are session secrets: they live only
 * inside the content script of the Photos tab and are never exported to the
 * service worker, other extension pages, logs or external clients.
 */

import type { AccountRef } from "../../domain/types.js";
import { ErrorCode, PixError } from "../../shared/errors.js";

/** Keys of `window.WIZ_global_data` we depend on (observed 2026-11-04). */
const WizKey = {
  xsrfToken: "SNlM0e",
  sessionId: "FdrFJe",
  buildLabel: "cfb2h",
  pathPrefix: "eptZe",
  email: "oPEP7c",
  gaiaId: "S06Grb",
  reauthProof: "Dbw5Ud",
} as const;

export class SessionContext {
  readonly account: AccountRef;
  readonly #xsrfToken: string;
  readonly #sessionId: string;
  readonly #buildLabel: string;
  readonly #pathPrefix: string;

  constructor(account: AccountRef, secrets: { xsrfToken: string; sessionId: string; buildLabel: string; pathPrefix: string }) {
    this.account = account;
    this.#xsrfToken = secrets.xsrfToken;
    this.#sessionId = secrets.sessionId;
    this.#buildLabel = secrets.buildLabel;
    this.#pathPrefix = secrets.pathPrefix;
  }

  /** Absolute batchexecute endpoint for this account. */
  batchExecuteUrl(origin: string): string {
    return `${origin}${this.#pathPrefix}data/batchexecute`;
  }

  /** Query parameters the batchexecute endpoint expects. */
  batchExecuteParams(rpcId: string, sourcePath: string, reqId: number): URLSearchParams {
    return new URLSearchParams({
      rpcids: rpcId,
      "source-path": sourcePath,
      "f.sid": this.#sessionId,
      bl: this.#buildLabel,
      hl: "en",
      _reqid: String(reqId),
      rt: "c",
    });
  }

  /** Form body field carrying the XSRF token. */
  xsrfFormField(): string {
    return `at=${encodeURIComponent(this.#xsrfToken)}`;
  }

  /** Never leak secrets through accidental serialization. */
  toJSON(): { account: AccountRef } {
    return { account: this.account };
  }
}

/** Reads the session from the page's inline `WIZ_global_data` script (no MAIN-world injection needed). */
export class WizSessionReader {
  read(doc: Document, pathname: string): SessionContext {
    // Paragraph: locate and parse the inline bootstrap script.
    const script = Array.from(doc.querySelectorAll("script")).find((s) => s.textContent?.includes("WIZ_global_data"));
    if (!script?.textContent) {
      throw new PixError(ErrorCode.SessionUnavailable, "Google Photos bootstrap data not found; is this a signed-in Photos page?");
    }
    const data = WizSessionReader.parseWizScript(script.textContent);

    // Paragraph: extract and validate required fields; fail fast on anything missing.
    const required = (key: string): string => {
      const v = data[key];
      if (typeof v !== "string" || v.length === 0) {
        throw new PixError(ErrorCode.SessionUnavailable, `Google Photos session field is missing (${key}); the page may have changed or you are signed out.`, { key });
      }
      return v;
    };
    const email = required(WizKey.email);
    const gaiaRaw = data[WizKey.gaiaId];

    // Paragraph: build the context.
    return new SessionContext(
      {
        email,
        gaiaId: typeof gaiaRaw === "string" && /^\d+$/.test(gaiaRaw) ? gaiaRaw : null,
        authUserIndex: WizSessionReader.authUserIndexFromPath(pathname),
      },
      {
        xsrfToken: required(WizKey.xsrfToken),
        sessionId: required(WizKey.sessionId),
        buildLabel: required(WizKey.buildLabel),
        pathPrefix: required(WizKey.pathPrefix),
      },
    );
  }

  static parseWizScript(text: string): Record<string, unknown> {
    const m = text.match(/WIZ_global_data\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!m?.[1]) {
      throw new PixError(ErrorCode.SessionUnavailable, "Could not locate WIZ_global_data object literal.");
    }
    try {
      const parsed: unknown = JSON.parse(m[1]);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.SessionUnavailable, "WIZ_global_data is not valid JSON");
    }
  }

  static authUserIndexFromPath(pathname: string): number {
    const m = pathname.match(/^\/u\/(\d+)(\/|$)/);
    return m?.[1] ? Number(m[1]) : 0;
  }
}
