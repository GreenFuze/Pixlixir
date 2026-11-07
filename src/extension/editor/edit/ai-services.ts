/**
 * Where Edit can send a picture: AI sites the user is signed in to, and local engines they run
 * themselves (ADR-0009). Sign-in is read from the presence of named cookies, after an optional
 * permission; cookie values are never read.
 */

import { z } from "zod";
import { ErrorCode, PixError } from "../../../shared/errors.js";
import { LocalAddress, type EngineKind } from "./local-engines.js";

export interface AiService {
  id: string;
  name: string;
  url: string;
  /** Cookies that mean signed in. From memory, unverified: see ADR-0009. Absent for services the user added. */
  signedInCookies?: RegExp;
  /** Where those cookies are set, when not on the service's own host. Chrome hides a cookie without permission for its domain. */
  cookieOrigin?: string;
  /** A local engine rather than a site. */
  engine?: EngineKind;
}

export type SignIn = "in" | "out" | "unknown";

export const BUILT_IN_SERVICES: readonly AiService[] = [
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", signedInCookies: /^__Secure-next-auth\.session-token/ },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", signedInCookies: /^(__Secure-1PSID|SAPISID)$/, cookieOrigin: "https://google.com" },
  { id: "grok", name: "Grok", url: "https://grok.com/", signedInCookies: /^sso(-rw)?$/ },
];

export class ServiceUrl {
  /** A service address, or an error saying why not. */
  static parse(text: string): URL {
    let url: URL;
    try {
      url = new URL(text.trim());
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.InvalidService, "Not a web address", { text: text.slice(0, 80) });
    }
    if (url.protocol !== "https:") throw new PixError(ErrorCode.InvalidService, "The address must start with https://", { protocol: url.protocol });
    return url;
  }
}

const Saved = z.object({
  chosen: z.string().nullable(),
  added: z.array(z.object({ id: z.string(), name: z.string(), url: z.string() })),
  engines: z.array(z.object({ id: z.string(), name: z.string(), url: z.string(), engine: z.enum(["iopaint", "a1111"]) })).default([]),
  autoSend: z.boolean().default(true),
});
type SavedServices = z.infer<typeof Saved>;

/** Each Google account's added services and last choice. */
export class ServiceStore {
  static readonly PREFIX = "pixlixir.aiServices.";

  constructor(private readonly accountEmail: string) {}

  private get key(): string {
    return ServiceStore.PREFIX + this.accountEmail;
  }

  async load(): Promise<SavedServices> {
    const stored = (await chrome.storage.local.get(this.key))[this.key];
    if (stored === undefined) return { chosen: null, added: [], engines: [], autoSend: true };
    const parsed = Saved.safeParse(stored);
    if (!parsed.success) throw new PixError(ErrorCode.StorageFailed, "The saved AI services could not be read", { account: this.accountEmail });
    return parsed.data;
  }

  async list(): Promise<AiService[]> {
    const saved = await this.load();
    return [...BUILT_IN_SERVICES, ...saved.added, ...saved.engines];
  }

  async add(name: string, url: string): Promise<void> {
    const saved = await this.load();
    const clean = name.trim();
    if (clean === "") throw new PixError(ErrorCode.InvalidService, "Give the service a name");
    const entry = { id: crypto.randomUUID(), name: clean, url: ServiceUrl.parse(url).href };
    await chrome.storage.local.set({ [this.key]: { ...saved, added: [...saved.added, entry] } });
  }

  /** A local engine, at an address already allowed from the user's click. */
  async addEngine(name: string, address: string, engine: EngineKind): Promise<void> {
    const saved = await this.load();
    const clean = name.trim();
    if (clean === "") throw new PixError(ErrorCode.InvalidService, "Give the engine a name");
    await chrome.storage.local.set({ [this.key]: { ...saved, engines: [...saved.engines, { id: crypto.randomUUID(), name: clean, url: LocalAddress.parse(address), engine }] } });
  }

  async remove(id: string): Promise<void> {
    const saved = await this.load();
    await chrome.storage.local.set({ [this.key]: { ...saved, added: saved.added.filter((s) => s.id !== id), engines: saved.engines.filter((s) => s.id !== id), chosen: saved.chosen === id ? null : saved.chosen } });
  }

  async setAutoSend(autoSend: boolean): Promise<void> {
    await chrome.storage.local.set({ [this.key]: { ...(await this.load()), autoSend } });
  }

  async choose(id: string): Promise<void> {
    await chrome.storage.local.set({ [this.key]: { ...(await this.load()), chosen: id } });
  }
}

export class ServiceSignIn {
  /** Each built-in service's site, and the domain its sign-in cookies are set on. */
  static origins(): string[] {
    return [...new Set(BUILT_IN_SERVICES.flatMap((s) => [new URL(s.url).origin, ...(s.cookieOrigin ? [s.cookieOrigin] : [])]))].map((o) => `${o}/*`);
  }

  private static readonly PERMISSIONS = (): chrome.permissions.Permissions => ({ permissions: ["cookies"], origins: ServiceSignIn.origins() });

  /** Whether sign-in can be read without asking. */
  static allowed(): Promise<boolean> {
    return chrome.permissions.contains(ServiceSignIn.PERMISSIONS());
  }

  /** Asks for the permission. Must run from a click. */
  static request(): Promise<boolean> {
    return chrome.permissions.request(ServiceSignIn.PERMISSIONS());
  }

  /** Reads the state of each service. Only cookie names are looked at. */
  static async read(services: readonly AiService[]): Promise<Record<string, SignIn>> {
    const out: Record<string, SignIn> = {};
    const allowed = await ServiceSignIn.allowed();
    for (const service of services) {
      if (!allowed || !service.signedInCookies) {
        out[service.id] = "unknown";
        continue;
      }
      const cookies = await chrome.cookies.getAll({ url: service.url });
      out[service.id] = cookies.some((c) => service.signedInCookies!.test(c.name)) ? "in" : "out";
    }
    return out;
  }
}
