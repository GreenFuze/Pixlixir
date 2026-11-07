/**
 * End-to-end: the real build in real Chromium, against a fake Google backend (fake-photos.ts).
 * Covers what the editor sandboxes cannot, because they fake the extension APIs: message
 * sender checks, the modal iframe under a strict page CSP, and WebAssembly under the
 * extension's own CSP. Requires `npm run build` and `npx playwright install chromium`.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import ExifReader from "exifreader";
import jpeg from "jpeg-js";
import piexif from "piexifjs";
import { chromium, type BrowserContext, type Frame, type Page, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePhotos, makeOverlappingShots, type FakePhoto } from "./fake-photos.js";

const SOURCE_DIST = path.resolve(process.env.PIXLIXIR_DIST ?? "dist");
const T0 = Date.UTC(2024, 6, 14, 9, 0, 0);

/** The same JPEG with a date taken in its own details. */
function withTakenDate(file: Buffer, taken: string): Buffer {
  return Buffer.from(piexif.insert(piexif.dump({ "0th": {}, Exif: { [piexif.ExifIFD.DateTimeOriginal]: taken }, GPS: {}, Interop: {}, "1st": {} }), file.toString("binary")), "binary");
}

describe("real extension", () => {
  let context: BrowserContext;
  let sw: Worker;
  let extensionId: string;
  let fake: FakePhotos;
  let photos: FakePhoto[];
  let profile: string;

  beforeAll(async () => {
    // Paragraph: Chromium with the built extension.
    profile = mkdtempSync(path.join(tmpdir(), "pixlixir-e2e-"));

    // Paragraph: a copy with the optional permissions already granted, since no one can answer Chrome's question here.
    const DIST = path.join(profile, "extension");
    cpSync(SOURCE_DIST, DIST, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(DIST, "manifest.json"), "utf-8")) as { permissions: string[]; host_permissions: string[]; optional_permissions: string[]; optional_host_permissions: string[] };
    manifest.permissions.push(...manifest.optional_permissions);
    manifest.host_permissions.push(...manifest.optional_host_permissions);
    writeFileSync(path.join(DIST, "manifest.json"), JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] });
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    extensionId = new URL(sw.url()).host;

    // Paragraph: a 3-shot pan, plus a lone photo much later.
    const scratch = await context.newPage();
    const shots = await makeOverlappingShots(scratch, 3);
    await scratch.close();
    photos = shots.map((jpeg, i) => ({ mediaKey: `AF1QipFAKE${i}000000000`, dedupKey: `dedupFAKE${i}0000`, takenAtMs: T0 + i * 3000, jpeg, width: 800, height: 600 }));
    photos.push({ mediaKey: "AF1QipFAKELONE0000000", dedupKey: "dedupFAKELONE", takenAtMs: T0 + 86_400_000, jpeg: withTakenDate(shots[0]!, "2024:07:15 09:00:00"), width: 400, height: 300, fileName: "2022-12-02 (3).jpg" });
    photos.push({ mediaKey: "AF1QipFAKEWRONGDATE00", dedupKey: "dedupFAKEWRONGDATE", takenAtMs: T0 + 2 * 86_400_000, jpeg: shots[0]!, width: 800, height: 600, fileName: "IMG-20190512-WA0001.jpg" });
    photos.push({ mediaKey: "AF1QipFAKECUSTOM00000", dedupKey: "dedupFAKECUSTOM", takenAtMs: T0 + 3 * 86_400_000, jpeg: shots[0]!, width: 800, height: 600, fileName: "HOLIDAY_12-05-2018_beach.jpg" });
    fake = new FakePhotos(photos);
    await fake.install(context);
  });

  afterAll(async () => {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  });

  const LIBRARY = { kind: "library" };
  const panoramas = { panorama: true, dates: false, duplicates: false };

  /** A Photos tab known to the service worker, and its tab id. */
  async function openPhotos(): Promise<{ page: Page; tabId: number }> {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("https://photos.google.com/");
    await page.waitForSelector("pixlixir-launcher", { state: "attached" });
    const tabId = await sw.evaluate(async () => {
      for (let i = 0; i < 50; i++) {
        const [tab] = await chrome.tabs.query({ url: "https://photos.google.com/*", active: true });
        const state = (await chrome.storage.session.get("pixlixir.tabs"))["pixlixir.tabs"] as Record<string, { account: unknown }> | undefined;
        if (tab?.id !== undefined && state?.[tab.id]?.account) return tab.id;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the Photos tab never registered");
    });
    return { page, tabId };
  }

  /** Sends a message as an extension page shown in a tab (the case that used to be rejected). */
  async function asExtensionPage(message: unknown): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const reply = await page.evaluate((m) => {
      const { tabId, tabMessage } = m as { tabId?: number; tabMessage?: unknown };
      return tabMessage ? chrome.tabs.sendMessage(tabId!, tabMessage) : chrome.runtime.sendMessage(m);
    }, message);
    await page.close();
    return reply as { ok: boolean };
  }

  async function pageNamed(name: string): Promise<Page> {
    await expect.poll(() => context.pages().some((p) => p.url().includes(name)), { timeout: 10_000 }).toBe(true);
    return context.pages().find((p) => p.url().includes(name))!;
  }

  async function scanFrame(page: Page): Promise<Frame> {
    await expect.poll(() => page.frames().some((f) => f.url().includes("/scan.html")), { timeout: 10_000 }).toBe(true);
    const frame = page.frames().find((f) => f.url().includes("/scan.html"))!;
    await frame.waitForSelector(".app");
    return frame;
  }

  it("scans in a modal over Photos, bulk creates, and keeps the photos' metadata", async () => {
    // Paragraph: open the scan the way the side panel does.
    const { page, tabId } = await openPhotos();
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: panoramas, recheck: false } })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    expect(page.url()).toBe("https://photos.google.com/"); // a modal, not a new tab

    // Paragraph: the 3-shot pan is found, the lone photo is not.
    await frame.locator(".cand").first().waitFor({ timeout: 120_000 });
    await frame.getByRole("button", { name: "Scan again" }).waitFor({ timeout: 60_000 });
    expect(await frame.locator(".cand").count()).toBe(1);
    expect(await frame.locator(".cand .strip img").count()).toBe(3);
    expect(await frame.locator(".error-box").count()).toBe(0);

    // Paragraph: minimize keeps it alive, and the panel's Show brings it back.
    await frame.getByRole("button", { name: "Minimize" }).click();
    expect(await asExtensionPage({ tabId, tabMessage: { type: "modal.restore", expectedEmail: "e2e@example.com" } })).toMatchObject({ ok: true });
    expect(page.frames().filter((f) => f.url().includes("/scan.html"))).toHaveLength(1);

    // Paragraph: bulk create.
    await frame.getByRole("button", { name: "Create 1" }).click();
    await frame.locator(".modal").getByRole("button", { name: "Create" }).click();
    await frame.locator(".results").waitFor({ timeout: 120_000 });
    expect(await frame.locator(".results strong").innerText()).toContain("1 created");

    // Paragraph: the uploaded file carries the earliest photo's date and the location.
    expect(fake.uploads).toHaveLength(1);
    const bytes = fake.uploads[0]!.bytes;
    const tags = ExifReader.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { expanded: true });
    expect(tags.exif?.DateTimeOriginal?.description).toBe("2024:07:14 11:00:00");
    expect(tags.gps?.Latitude).toBeCloseTo(48.8584, 3);
    expect(tags.gps?.Longitude).toBeCloseTo(2.2945, 3);

    // Paragraph: date, album and description were applied to the new item.
    const rpcs = fake.calls.map((c) => c.rpc);
    expect(rpcs).toContain("DaSgWe");
    const add = fake.calls.find((c) => c.rpc === "E1Cajb")!.payload as unknown[];
    expect(add[1]).toBe("AF1QipFAKEALBUM00001");
    expect((fake.calls.find((c) => c.rpc === "AQNOFd")!.payload as unknown[])[1]).toBe("Harbour, morning");

    // Paragraph: closing removes the modal.
    await frame.getByRole("button", { name: "Close" }).click();
    await expect.poll(() => page.frames().some((f) => f.url().includes("/scan.html")), { timeout: 5000 }).toBe(false);
    await page.close();
  });

  it("later scans reuse saved results unless asked to re-check", async () => {
    // Paragraph: the first test already scanned this library, so nothing is downloaded now.
    const { page, tabId } = await openPhotos();
    const before = fake.renditions;
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: { panorama: true, dates: true, duplicates: false }, recheck: false } })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    await frame.getByRole("button", { name: "Scan again" }).waitFor({ timeout: 60_000 });
    expect(await frame.locator(".status-bar").innerText()).toContain("already checked");
    expect(fake.renditions).toBe(before);

    // Paragraph: each thing looked for has its own tab, with its own results and actions.
    // The first test made this panorama, so it is counted and not shown again.
    expect(await frame.getByRole("tab").allInnerTexts()).toEqual(["Panoramas 0", expect.stringMatching(/^Wrong dates \d+$/)]);
    await frame.getByRole("tab", { name: /Panoramas/ }).click();
    expect(await frame.locator(".cand").count()).toBe(0);
    await frame.getByText("1 already made").waitFor();
    expect(await frame.locator(".date-rows").count()).toBe(0);
    await frame.getByRole("tab", { name: /Wrong dates/ }).click();
    expect(await frame.locator(".cand").count()).toBe(0);
    expect(await frame.locator("footer").count()).toBe(0);
    expect(await frame.getByText("names match no format").count()).toBe(1);

    // Paragraph: finished results make way for a new plan, and "Re-check all" downloads the thumbnails again.
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: panoramas, recheck: true } })).toMatchObject({ ok: true });
    await expect.poll(() => fake.renditions, { timeout: 120_000 }).toBeGreaterThan(before);

    // Paragraph: while it runs, another plan brings it back instead of replacing it.
    const running = page.frames().find((f) => f.url().includes("/scan.html"))!;
    const url = running.url();
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: { panorama: false, dates: true, duplicates: false }, recheck: false } })).toMatchObject({ ok: true });
    expect(page.frames().find((f) => f.url().includes("/scan.html"))!.url()).toBe(url);
    await running.getByRole("button", { name: "Scan again" }).waitFor({ timeout: 120_000 });
    await running.getByRole("button", { name: "Close" }).click();
    await page.close();
  });

  it("lets each finding be chosen, even while the scan is still running", async () => {
    // Paragraph: dates arrive first, while the panorama check is still going: they can be chosen, not yet fixed.
    const { page, tabId } = await openPhotos();
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: { panorama: true, dates: true, duplicates: false }, recheck: true } })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    await frame.locator(".date-rows li").first().waitFor({ timeout: 60_000 });
    expect(await frame.getByRole("button", { name: "Stop", exact: true }).count()).toBe(1);
    const boxes = frame.locator(".date-rows input");
    const total = await boxes.count();
    expect(await boxes.first().isDisabled()).toBe(false);
    await boxes.first().uncheck();
    await frame.getByRole("button", { name: `Fix ${total - 1}` }).waitFor();
    await boxes.first().check();
    const fix = frame.getByRole("button", { name: /^Fix \d+$/ }); // the search for originals can add a row when the scan ends
    expect(await frame.getByRole("button", { name: "Stop", exact: true }).count()).toBe(1); // still scanning, so this is why it waits
    expect(await fix.isDisabled()).toBe(true);
    await boxes.first().uncheck();

    // Paragraph: the choice survives the end of the scan, and only then can it run.
    await frame.getByRole("button", { name: "Scan again" }).waitFor({ timeout: 120_000 });
    expect(await boxes.first().isChecked()).toBe(false);
    await boxes.first().check();
    expect(await fix.isDisabled()).toBe(false);

    // Paragraph: one panorama can be chosen, by its box or its picture.
    await frame.getByRole("tab", { name: /Panoramas/ }).click();
    await frame.getByRole("button", { name: "None" }).click();
    await frame.getByRole("button", { name: "Create 0" }).waitFor();
    await frame.locator(".cand input[type=checkbox]").check();
    await frame.getByRole("button", { name: "Create 1" }).waitFor();
    await frame.locator(".cand-preview").click();
    await frame.getByRole("button", { name: "Create 0" }).waitFor();
    await frame.getByRole("button", { name: "Close" }).click();
    await page.close();
  });

  it("edits a photo: brush, carry the picture to a service, paste the result, save as new", async () => {
    // Paragraph: a stand-in AI site on this computer, whose own script takes a pasted picture like the real ones, and a page with no message box. Never a real site: routes do not catch every new window.
    const standIn = `<title>site</title><form><div id="att"></div><div id="box" contenteditable="true" role="textbox" style="min-height:40px"></div><button id="go" type="submit" disabled>go</button></form><script>
      window.got = { pasted: 0, sent: 0, text: null, type: null, size: 0 };
      const update = () => { go.disabled = !(box.textContent.trim() && got.pasted); };
      box.addEventListener("paste", (e) => { const f = e.clipboardData.files[0]; if (!f) return; e.preventDefault(); got.pasted++; got.type = f.type; got.size = f.size; const i = new Image(); i.src = URL.createObjectURL(f); att.append(i); update(); });
      box.addEventListener("input", update);
      document.querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); got.sent++; got.text = box.textContent; box.textContent = ""; });
    </script>`;
    const sites = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/chat" ? standIn : "<title>sign in</title><h1>Sign in</h1>");
    });
    await new Promise<void>((resolve) => sites.listen(0, "127.0.0.1", resolve));
    const siteAddress = `http://127.0.0.1:${(sites.address() as AddressInfo).port}`;
    await sw.evaluate((address) => chrome.storage.local.set({ "pixlixir.aiServices.e2e@example.com": { chosen: null, engines: [], autoSend: true, added: [{ id: "chat", name: "Stand-in", url: `${address}/chat` }, { id: "nobox", name: "No box", url: `${address}/signin` }] } }), siteAddress);
    type SiteState = { pasted: number; sent: number; text: string | null; type: string | null; size: number };
    const opens = () => context.waitForEvent("page", (p) => p.url().startsWith(`${siteAddress}/chat`));
    const status = () => editor.getByRole("dialog").locator(".pill, .error-box").evaluateAll((all) => all.map((e) => `${e.textContent} ${e.getAttribute("title") ?? ""}`).join(" | "));

    // Paragraph: open Edit on one photo.
    const { tabId } = await openPhotos();
    const lone = photos.find((p) => p.mediaKey === "AF1QipFAKELONE0000000")!;
    const opened = context.waitForEvent("page", (p) => p.url().includes("/edit.html"));
    expect(await asExtensionPage({ type: "panel.openTool", tool: "edit", tabId, mediaKeys: [lone.mediaKey] })).toMatchObject({ ok: true });
    const editor = await opened;
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await editor.bringToFront();

    // Paragraph: Erase needs a brush; Send waits for one.
    const frame = editor.locator(".edit-frame img");
    await frame.waitFor({ timeout: 60_000 });
    await editor.getByRole("combobox", { name: "Service" }).selectOption({ label: "Stand-in" });
    const send = editor.getByRole("button", { name: "Send", exact: true });
    expect(await send.isDisabled()).toBe(true);
    const box = (await frame.boundingBox())!;
    await editor.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await editor.mouse.down();
    await editor.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 4 });
    await editor.mouse.up();

    // Paragraph: Send opens the site, and the picture and prompt arrive through the site's own handlers, then send is pressed, once.
    const siteOpening = opens();
    await send.click();
    const site = await siteOpening;
    const dialog = editor.getByRole("dialog");
    await editor.bringToFront();
    await expect.poll(status, { timeout: 45_000 }).toContain("Sent");
    const got = await site.evaluate(() => (window as unknown as { got: SiteState }).got);
    expect(got).toMatchObject({ pasted: 1, sent: 1, type: "image/png" });
    expect(got.size).toBeGreaterThan(100);
    expect(got.text).toContain("magenta");
    expect(await editor.evaluate(async () => (await navigator.clipboard.read())[0]!.types)).toContain("image/png");
    await dialog.getByRole("button", { name: "Copy prompt" }).click();
    expect(await editor.evaluate(() => navigator.clipboard.readText())).toContain("magenta");
    await site.close();

    // Paragraph: with the option off, the box is filled and pressing send is left to the user.
    await dialog.getByRole("button", { name: "Close" }).click();
    await editor.getByRole("checkbox", { name: "Send automatically" }).uncheck();
    const fillOpening = opens();
    await send.click();
    const filled = await fillOpening;
    await editor.bringToFront();
    await expect.poll(status, { timeout: 45_000 }).toContain("Press Send there");
    expect(await filled.evaluate(() => (window as unknown as { got: SiteState }).got)).toMatchObject({ pasted: 1, sent: 0 });
    expect(await filled.evaluate(() => document.querySelector("#box")!.textContent)).toContain("magenta");
    await filled.close();

    // Paragraph: a page without a message box is reported, and the user carries on by hand.
    await dialog.getByRole("button", { name: "Close" }).click();
    await editor.getByRole("combobox", { name: "Service" }).selectOption({ label: "No box" });
    const signInOpening = context.waitForEvent("page", (p) => p.url().startsWith(`${siteAddress}/signin`));
    await send.click();
    const signIn = await signInOpening;
    await editor.bringToFront();
    await expect.poll(status, { timeout: 45_000 }).toContain("Paste it yourself");
    await signIn.close();

    // Paragraph: the picture sent has no EXIF, and shows the marking.
    const sent = await editor.evaluate(async () => {
      const img = document.querySelector<HTMLImageElement>(".edit-send img")!;
      const blob = await (await fetch(img.src)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let tinted = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! > d[i + 1]! + 40 && d[i + 2]! > d[i + 1]! + 40) tinted++;
      return { type: blob.type, width: bitmap.width, height: bitmap.height, tinted, head: [...new Uint8Array(await blob.arrayBuffer())].slice(0, 4) };
    });
    expect(sent.type).toBe("image/png");
    expect(sent.tinted).toBeGreaterThan(0);

    // Paragraph: a result that is the sent picture, its marked area still magenta and everything else shifted to white, pasted back.
    const result = await editor.evaluate(async (s) => {
      const canvas = new OffscreenCanvas(s.width, s.height);
      const ctx = canvas.getContext("2d")!;
      const img = await createImageBitmap(await (await fetch(document.querySelector<HTMLImageElement>(".edit-send img")!.src)).blob());
      ctx.drawImage(img, 0, 0);
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = "rgb(30,30,30)"; // a redraw changes everything a little: only the brush may reach the photo
      ctx.fillRect(0, 0, s.width, s.height);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const file = new File([blob], "result.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      return blob.size;
    }, sent);
    expect(result).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: "Use", exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Use", exact: true }).click();
    await dialog.waitFor({ state: "detached" });

    // Paragraph: saved as a new item, with the original's date.
    const before = fake.uploads.length;
    await editor.getByRole("button", { name: "Save as new" }).click();
    const save = editor.getByRole("dialog");
    await save.getByRole("button", { name: "Save", exact: true }).click();
    await editor.locator("a.pill.ok", { hasText: "Saved" }).waitFor({ timeout: 60_000 });
    expect(fake.uploads.length).toBe(before + 1);
    expect(fake.uploads[before]!.fileName).toMatch(/_edit\.jpg$/);

    // Paragraph: the saved file: same size, the brushed middle changed, the rest as it was.
    const saved = jpeg.decode(fake.uploads[before]!.bytes), original = jpeg.decode(lone.jpeg);
    expect([saved.width, saved.height]).toEqual([original.width, original.height]);
    const difference = (fx: number, fy: number) => {
      const x = Math.floor(saved.width * fx), y = Math.floor(saved.height * fy), k = (y * saved.width + x) * 4;
      return Math.abs(saved.data[k]! - original.data[k]!) + Math.abs(saved.data[k + 1]! - original.data[k + 1]!) + Math.abs(saved.data[k + 2]! - original.data[k + 2]!);
    };
    expect(difference(0.52, 0.52)).toBeGreaterThan(30); // inside the brush
    for (const [fx, fy] of [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95], [0.5, 0.05], [0.05, 0.5]] as const) expect(difference(fx, fy)).toBeLessThan(15);
    await editor.close();
    sites.closeAllConnections();
    await new Promise((resolve) => sites.close(resolve));
  });

  it("edits with a local engine and the built-in fixes, and records the edit", async () => {
    // Paragraph: the user's engine: a real server on this computer, or a stand-in that answers with what it was given.
    const posts: { image: string; mask: string; prompt: string; sd_strength: number }[] = [];
    const modelInfos = [{ name: "lama", need_prompt: false, support_strength: false }, { name: "text-model", need_prompt: true, support_strength: true }];
    let currentModel = "lama";
    const switches: string[] = [];
    const server = createServer((req, res) => {
      // Paragraph: no CORS headers: the address's permission must be enough, so users need no extra server flags.
      const reply = (value: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(value));
      };
      if (req.method === "GET" && req.url === "/api/v1/server-config") return reply({ modelInfos });
      if (req.method === "GET" && req.url === "/api/v1/model") return reply({ name: currentModel });
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/api/v1/model") {
          currentModel = (JSON.parse(Buffer.concat(chunks).toString()) as { name: string }).name;
          switches.push(currentModel);
          return reply({ name: currentModel });
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { image: string; mask: string; prompt: string; sd_strength: number };
        posts.push(body);
        res.setHeader("content-type", "image/png");
        res.end(Buffer.from(body.image, "base64"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = process.env.PIXLIXIR_IOPAINT ?? `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Paragraph: set up in Settings, for this account.
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/settings.html?email=e2e@example.com`);
    const kinds = settings.getByRole("list", { name: "Supported engines" });
    expect(await kinds.getByRole("link", { name: /SD\.Next/ }).getAttribute("href")).toBe("https://github.com/vladmandic/sdnext");
    expect(await kinds.getByRole("link", { name: /IOPaint/ }).getAttribute("href")).toBe("https://github.com/Sanster/IOPaint");
    expect(await kinds.getByText("IOPaint", { exact: true }).getAttribute("title")).toContain("POST /api/v1/inpaint");
    await settings.getByRole("textbox", { name: "Engine name" }).fill("My engine");
    await settings.getByRole("textbox", { name: "Engine address" }).fill(address);
    await settings.getByRole("button", { name: "Add engine" }).click();
    await settings.getByText("My engine").waitFor();
    expect(await settings.getByRole("link", { name: "Open UI" }).first().getAttribute("href")).toBe(new URL(address).origin);

    // Paragraph: commands for the chosen device, since an extension cannot start a program.
    await settings.getByRole("textbox", { name: "Engine address" }).fill("http://127.0.0.1:8080");
    await settings.getByText("iopaint start --model=lama --device=cuda --port=8080").waitFor();
    await settings.getByRole("combobox", { name: "Device" }).selectOption("cpu");
    await settings.getByText("iopaint start --model=lama --device=cpu --port=8080").waitFor();
    await settings.getByRole("textbox", { name: "Model to run" }).fill("mat");
    await settings.getByText("iopaint download --model=mat").waitFor();
    await settings.getByRole("textbox", { name: "Model to run" }).fill("a b");
    await settings.getByText("A model name has only").waitFor();
    await settings.close();

    // Paragraph: an engine that needs a brush waits for one.
    const { tabId } = await openPhotos();
    const lone = photos.find((p) => p.mediaKey === "AF1QipFAKELONE0000000")!;
    const opened = context.waitForEvent("page", (p) => p.url().includes("/edit.html"));
    expect(await asExtensionPage({ type: "panel.openTool", tool: "edit", tabId, mediaKeys: [lone.mediaKey] })).toMatchObject({ ok: true });
    const editor = await opened;
    await editor.bringToFront();
    const frame = editor.locator(".edit-frame img");
    await frame.waitFor({ timeout: 60_000 });
    await editor.getByRole("combobox", { name: "Service" }).selectOption({ label: "My engine" });
    const modelChoice = editor.getByRole("combobox", { name: "Model" });
    await expect.poll(() => modelChoice.inputValue(), { timeout: 30_000 }).toBe("lama");
    expect(await editor.getByRole("link", { name: "Open UI" }).getAttribute("href")).toBe(new URL(address).origin);

    // Paragraph: a model that only fills a brushed area waits for one, whatever the text says.
    await editor.getByRole("radio", { name: "Enhance" }).click();
    const send = editor.getByRole("button", { name: "Send", exact: true });
    await editor.getByText("Needs a brush").waitFor();
    expect(await send.isDisabled()).toBe(true);

    // Paragraph: on the real server, switching reaches it and comes back.
    if (process.env.PIXLIXIR_IOPAINT) {
      const serverModel = async () => ((await (await fetch(`${address}/api/v1/model`)).json()) as { name: string }).name;
      await modelChoice.selectOption("cv2");
      await expect.poll(serverModel, { timeout: 60_000 }).toBe("cv2");
      await modelChoice.selectOption("lama");
      await expect.poll(serverModel, { timeout: 60_000 }).toBe("lama");
      await expect.poll(() => modelChoice.isDisabled(), { timeout: 60_000 }).toBe(false);
    }

    // Paragraph: a model that follows text needs none: it gets the whole picture to work on.
    if (!process.env.PIXLIXIR_IOPAINT) {
      await modelChoice.selectOption("text-model");
      await expect.poll(() => switches.join()).toBe("text-model");
      await expect.poll(() => send.isDisabled()).toBe(false);
      await editor.getByRole("slider", { name: "Strength" }).fill("0.5");
      await send.click();
      await editor.getByRole("dialog").getByRole("button", { name: "Use", exact: true }).waitFor({ timeout: 30_000 });
      expect(posts).toHaveLength(1);
      expect(posts[0]!.prompt).toContain("Improve the light");
      expect(posts[0]!.sd_strength).toBe(0.5);
      const wholeMask = await editor.evaluate(async (b64) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data.every((v) => v === 255);
      }, posts[0]!.mask);
      expect(wholeMask).toBe(true);
      await editor.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      posts.length = 0;
      await modelChoice.selectOption("lama");
      await expect.poll(() => switches.join()).toBe("text-model,lama");
    }
    await editor.getByRole("radio", { name: "Erase" }).click();
    const box = (await frame.boundingBox())!;
    await editor.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await editor.mouse.down();
    await editor.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 4 });
    await editor.mouse.up();

    // Paragraph: the brush can be resized, undone and deleted, and is drawn again afterwards.
    const undoStroke = editor.getByRole("button", { name: "Undo stroke" });
    await undoStroke.click();
    expect(await undoStroke.isDisabled()).toBe(true);
    await editor.getByRole("slider", { name: "Brush size" }).fill("0.06");
    for (const offset of [0, 0.1]) {
      await editor.mouse.move(box.x + box.width * (0.5 + offset), box.y + box.height * 0.5);
      await editor.mouse.down();
      await editor.mouse.move(box.x + box.width * (0.55 + offset), box.y + box.height * 0.55, { steps: 4 });
      await editor.mouse.up();
    }
    await editor.getByRole("button", { name: "Delete brush" }).click();
    expect(await undoStroke.isDisabled()).toBe(true);
    await editor.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await editor.mouse.down();
    await editor.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55, { steps: 4 });
    await editor.mouse.up();
    await send.click();

    // Paragraph: the engine gets a clean picture and an exact mask of the same size, not the magenta marking.
    const uploadsAtStart = fake.uploads.length;
    const dialog = editor.getByRole("dialog");
    await dialog.getByRole("button", { name: "Use", exact: true }).waitFor({ timeout: process.env.PIXLIXIR_IOPAINT ? 300_000 : 30_000 });
    if (!process.env.PIXLIXIR_IOPAINT) {
      expect(posts).toHaveLength(1);
      expect(posts[0]!.prompt).toContain("Remove it");
      const seen = await editor.evaluate(async ({ image, mask }) => {
        const shown = await (await fetch(document.querySelector<HTMLImageElement>(".edit-send img")!.src)).blob();
        const decode = async (b64: string) => (await fetch(`data:image/png;base64,${b64}`)).blob();
        const read = async (blob: Blob) => {
          const bitmap = await createImageBitmap(blob);
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          return { width: bitmap.width, height: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
        };
        const [picture, brush, marked] = await Promise.all([read(await decode(image)), read(await decode(mask)), read(shown)]);
        let white = 0, other = 0, unmarkedUnderBrush = 0;
        for (let i = 0; i < brush.data.length; i += 4) {
          if (brush.data[i] === 255) {
            white++;
            if (Math.abs(picture.data[i]! - marked.data[i]!) + Math.abs(picture.data[i + 1]! - marked.data[i + 1]!) > 20) unmarkedUnderBrush++;
          } else if (brush.data[i] !== 0) other++;
        }
        return { same: picture.width === brush.width && picture.height === brush.height, white, other, unmarkedUnderBrush };
      }, posts[0]!);
      expect(seen).toMatchObject({ same: true, other: 0 });
      expect(seen.white).toBeGreaterThan(0);
      expect(seen.unmarkedUnderBrush).toBeGreaterThan(seen.white * 0.5); // the marking was left out
    }

    // Paragraph: a result can be kept on this computer: full size, with the original's date details, and nothing uploaded.
    const downloading = editor.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/_edit\.jpg$/);
    const kept = readFileSync(await download.path());
    const keptSize = jpeg.decode(kept), sourceSize = jpeg.decode(lone.jpeg);
    expect([keptSize.width, keptSize.height]).toEqual([sourceSize.width, sourceSize.height]);
    expect(piexif.load(kept.toString("binary")).Exif[piexif.ExifIFD.DateTimeOriginal]).toBe("2024:07:15 09:00:00");
    await dialog.getByRole("button", { name: "Use", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    expect(fake.uploads.length).toBe(uploadsAtStart); // a result reaches Google Photos only through Save

    // Paragraph: the built-in fixes, on this computer: Done makes the next version, the same way up.
    await editor.getByRole("button", { name: "Auto fix" }).click();
    const panel = editor.getByRole("dialog", { name: "Auto fix" });
    await panel.locator(".fx-canvas img").first().waitFor({ timeout: 60_000 });
    await panel.getByRole("button", { name: "Done" }).click();
    await panel.waitFor({ state: "detached", timeout: 60_000 });
    await editor.getByRole("button", { name: "Undo edit" }).waitFor();
    expect(fake.uploads.length).toBe(uploadsAtStart);

    // Paragraph: saved, and recorded with what made it.
    const before = fake.uploads.length;
    await editor.getByRole("button", { name: "Save as new" }).click();
    await editor.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await editor.locator("a.pill.ok", { hasText: "Saved" }).waitFor({ timeout: 60_000 });
    const saved = jpeg.decode(fake.uploads[before]!.bytes), original = jpeg.decode(lone.jpeg);
    expect([saved.width, saved.height]).toEqual([original.width, original.height]);
    const brightness = (img: { width: number; height: number; data: Uint8Array }, fx: number, fy: number) => img.data[(Math.floor(img.height * fy) * img.width + Math.floor(img.width * fx)) * 4 + 1]!;
    const grid = [0.1, 0.3, 0.7, 0.9].flatMap((fx) => [0.1, 0.9].map((fy) => [fx, fy] as const));
    const a = grid.map(([x, y]) => brightness(saved, x, y)), b = grid.map(([x, y]) => brightness(original, x, y));
    const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
    const [ma, mb] = [mean(a), mean(b)];
    const agreement = a.reduce((s, x, i) => s + (x - ma) * (b[i]! - mb), 0) / Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) * b.reduce((s, x) => s + (x - mb) ** 2, 0));
    expect(agreement).toBeGreaterThan(0.8); // not flipped or turned
    const job = await editor.evaluate(() => new Promise<{ kind: string; status: string; steps: { by: string }[]; saved: unknown }>((resolve, reject) => {
      const open = indexedDB.open("pixlixir");
      open.onerror = () => reject(new Error("no database"));
      open.onsuccess = () => {
        const all = open.result.transaction("jobs").objectStore("jobs").getAll();
        all.onsuccess = () => {
          const edits = (all.result as { kind: string; createdAt: number }[]).filter((j) => j.kind === "edit").sort((x, y) => y.createdAt - x.createdAt);
          open.result.close();
          resolve(edits[0] as never);
        };
      };
    }));
    expect(job).toMatchObject({ status: "done", steps: [{ by: "My engine" }, { by: "Auto fix" }] });
    expect(job.saved).not.toBeNull();
    await editor.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("refuses a scan frame that was not opened through the extension", async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/scan.html?tab=1&email=a@b.com&sel=forged`);
    await page.waitForSelector(".error-box");
    expect(await page.locator(".error-box").innerText()).toContain("Start the scan from the Pixlixir menu");
    await page.close();
  });

  it("refuses a scan handed over for another account", async () => {
    await sw.evaluate(() => chrome.storage.session.set({ "pixlixir.scanSelection.other": { accountEmail: "second@example.com", plan: { scope: { kind: "library" }, detectors: { panorama: false, dates: true, duplicates: false }, recheck: false } } }));
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/scan.html?tab=1&email=e2e@example.com&sel=other`);
    await page.waitForSelector(".error-box");
    expect(await page.locator(".error-box").innerText()).toContain("Start the scan from the Pixlixir menu");
    await page.close();
  });

  it("keeps filename formats per account, and fixes, verifies and undoes wrong dates", async () => {
    // Paragraph: a format added in Settings, for this account only.
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/settings.html?email=e2e@example.com`);
    await settings.getByRole("textbox", { name: "New format" }).fill("HOLIDAY_dd-mm-yyyy_*.*");
    await settings.getByRole("button", { name: "Add", exact: true }).click();
    await settings.getByText("HOLIDAY_dd-mm-yyyy_*.*").waitFor();

    // Paragraph: added AI services stay with the account; an insecure address is refused.
    await settings.getByRole("textbox", { name: "Service name" }).fill("My model");
    await settings.getByRole("textbox", { name: "Service address" }).fill("http://example.test/");
    await settings.getByRole("button", { name: "Add service" }).click();
    await settings.getByText("The address must start with https://").waitFor();
    await settings.getByRole("textbox", { name: "Service address" }).fill("https://example.test/model");
    await settings.getByRole("button", { name: "Add service" }).click();
    await settings.getByText("My model").waitFor();
    await settings.reload();
    await settings.getByText("HOLIDAY_dd-mm-yyyy_*.*").waitFor();
    await settings.goto(`chrome-extension://${extensionId}/settings.html?email=second@example.com`);
    await settings.getByText("*-yyyymmdd-WA*.*").waitFor();
    expect(await settings.getByText("HOLIDAY_dd-mm-yyyy_*.*").count()).toBe(0);
    await settings.close();

    // Paragraph: only the date check, so no stitching. Both names are found, from different formats, and one saved copy apart from them.
    const lone = photos.find((p) => p.mediaKey === "AF1QipFAKELONE0000000")!;
    const loneBefore = lone.takenAtMs;
    const { page, tabId } = await openPhotos();
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: { panorama: false, dates: true, duplicates: false }, recheck: false } })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    await frame.locator(".date-rows li").nth(2).waitFor({ timeout: 60_000 });
    await frame.getByRole("button", { name: "Scan again" }).waitFor();
    expect(await frame.locator(".date-rows:not(.copies) li").count()).toBe(2);
    expect(await frame.locator(".date-rows.copies li").innerText()).toContain("2022-12-02 (3).jpg");
    expect(await frame.locator(".date-rows.copies .row-help").getAttribute("title")).toContain("the file's own date is"); // read from the file, through the Photos tab
    expect(await frame.locator(".date-rows:not(.copies) .row-help").first().getAttribute("title")).toContain("Fix writes the name's date");
    expect(await frame.getByText("1 saved copy").count()).toBe(1);
    expect(await frame.locator(".status-bar").innerText()).toContain("took "); // how long the scan took
    await frame.locator(".date-rows.copies .date-original img").waitFor({ timeout: 60_000 }); // its original was looked for without being asked
    expect(await frame.locator(".date-rows.copies .row-help").getAttribute("title")).toContain("likely original was taken");
    expect(await frame.getByRole("button", { name: "Find originals" }).count()).toBe(0);
    await frame.getByRole("button", { name: "None", exact: true }).click();
    for (const box of await frame.locator(".date-rows:not(.copies) input[type=checkbox]").all()) await box.check();
    await frame.getByRole("button", { name: "Fix 2" }).waitFor();

    // Paragraph: a date Google does not take stops the run and says so; the other was kept and is undoable.
    const wa = photos.find((p) => p.fileName?.startsWith("IMG-"))!;
    const custom = photos.find((p) => p.fileName?.startsWith("HOLIDAY"))!;
    const [waBefore, customBefore] = [wa.takenAtMs, custom.takenAtMs];
    fake.refuseDates.add(custom.dedupKey);
    await frame.getByRole("button", { name: "Fix 2" }).click();
    await frame.locator(".modal").getByRole("button", { name: "Change dates" }).click();
    await frame.locator(".dates .error-box").waitFor({ timeout: 30_000 });
    expect(await frame.locator(".dates .error-box").innerText()).toContain("1 of 2 items did not get the new date");
    expect(new Date(wa.takenAtMs + 7_200_000).toISOString().slice(0, 10)).toBe("2019-05-12");
    expect(new Date(wa.takenAtMs + 7_200_000).toISOString().slice(11, 19)).toBe(new Date(waBefore + 7_200_000).toISOString().slice(11, 19)); // keeps the time of day
    expect(custom.takenAtMs).toBe(customBefore);

    // Paragraph: undo puts the changed one back.
    fake.refuseDates.clear();
    await frame.getByRole("button", { name: "Undo" }).click();
    await frame.locator(".modal").getByRole("button", { name: "Put back" }).click();
    await expect.poll(() => wa.takenAtMs, { timeout: 30_000 }).toBe(waBefore);
    expect(lone.takenAtMs).toBe(loneBefore);

    // Paragraph: find the copy's original: its date and time zone can be taken, checked and undone.
    const firstShot = photos[0]!;
    await frame.getByRole("button", { name: "None", exact: true }).click();
    await frame.getByRole("checkbox", { name: "Fix 2022-12-02 (3).jpg" }).check();
    await frame.getByRole("button", { name: "Fix 1", exact: true }).click();
    await frame.locator(".modal").getByRole("button", { name: "Change dates" }).click();
    await expect.poll(() => lone.takenAtMs, { timeout: 30_000 }).toBe(firstShot.takenAtMs);
    await frame.locator(".modal").waitFor({ state: "detached" });
    await frame.getByRole("button", { name: "Undo" }).waitFor();
    await frame.getByRole("button", { name: "Undo" }).click();
    await frame.locator(".modal").getByRole("button", { name: "Put back" }).click();
    await expect.poll(() => lone.takenAtMs, { timeout: 30_000 }).toBe(loneBefore);

    // Paragraph: the user can say a name really is the date taken.
    await frame.getByRole("button", { name: "Use name" }).click();
    expect(await frame.locator(".date-rows.copies").count()).toBe(0);
    expect(await frame.locator(".date-rows li").count()).toBe(3);
    await frame.getByRole("button", { name: "Close" }).click();
    await page.close();
  });

  it("fixes the dates of selected photos, and scans from Bulk operations, from the side panel", async () => {
    // Paragraph: the panel next to a Photos tab, with one photo ticked. Clicks reach a background tab.
    const { page } = await openPhotos();
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 360, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.bringToFront();
    const fixDates = panel.getByRole("button", { name: "Fix dates from file names" });
    await panel.getByRole("button", { name: "Select photos or videos to fix their dates from their file names." }).waitFor({ timeout: 15_000 });
    expect(await panel.getByRole("button", { name: "Select 2–40 overlapping photos" }).isDisabled()).toBe(true);
    await page.evaluate(() => document.querySelector('[data-key="AF1QipFAKEWRONGDATE00"]')!.setAttribute("aria-checked", "true"));
    await fixDates.waitFor({ timeout: 15_000 });

    // Paragraph: Fix dates goes straight to the review, for that photo only.
    await fixDates.click();
    const frame = await scanFrame(page);
    await frame.locator(".date-rows li").first().waitFor({ timeout: 60_000 });
    await frame.getByRole("button", { name: "Scan again" }).waitFor();
    expect(await frame.locator(".date-rows li").count()).toBe(1);
    expect(await frame.locator(".date-rows").first().innerText()).toContain("IMG-20190512-WA0001.jpg");
    expect(await frame.locator(".cand").count()).toBe(0);
    expect(await frame.locator("h1").innerText()).toBe("Fix dates");
    // Mouse input does not reach a frame while the panel shares the window here; the other tests click it for real.
    await frame.getByRole("button", { name: "Close" }).dispatchEvent("click");
    await expect.poll(() => page.frames().some((f) => f.url().includes("/scan.html")), { timeout: 5000 }).toBe(false);
    await page.evaluate(() => document.querySelector('[data-key="AF1QipFAKEWRONGDATE00"]')!.setAttribute("aria-checked", "false"));

    // Paragraph: Bulk operations: the settings are in the panel, and Scan starts at once.
    await panel.getByRole("radio", { name: "Whole library" }).click();
    await panel.getByLabel("Panoramas").uncheck();
    await panel.getByRole("button", { name: "Scan", exact: true }).click();
    const bulk = await scanFrame(page);
    await bulk.locator(".date-rows li").first().waitFor({ timeout: 60_000 });
    await bulk.getByRole("button", { name: "Scan again" }).waitFor();
    expect(await bulk.locator(".date-rows li").count()).toBeGreaterThan(0);
    expect(await bulk.locator(".status-bar strong").innerText()).toBe("Your whole library");
    await bulk.getByRole("button", { name: "Close" }).dispatchEvent("click");
    await panel.close();
    await page.close();
  });

  it("moves a saved panorama's originals to trash, from the editor and from the scan, and proves it", async () => {
    const dedups = photos.slice(0, 3).map((p) => p.dedupKey);
    const trashCalls = () => fake.calls.filter((c) => c.rpc === "XwAOJf");
    const { page, tabId } = await openPhotos();

    // Paragraph: the editor in a tab: nothing is offered before saving, then a confirm dialog that can be cancelled.
    expect(await asExtensionPage({ type: "panel.openTool", tool: "panorama", tabId, mediaKeys: photos.slice(0, 3).map((p) => p.mediaKey) })).toMatchObject({ ok: true });
    const editor = await pageNamed("panorama.html");
    await editor.waitForSelector(".pano-stage img", { timeout: 120_000 });
    expect(await editor.getByRole("button", { name: "Trash originals" }).count()).toBe(0);
    await editor.getByRole("button", { name: "Save to Google Photos" }).click();
    await editor.locator(".modal").getByRole("button", { name: "Save" }).click();
    await editor.getByRole("button", { name: "Trash originals" }).waitFor({ timeout: 120_000 });
    await editor.getByRole("button", { name: "Trash originals" }).click();
    expect(await editor.locator(".modal h2").innerText()).toBe("Move 3 originals to trash?");
    await editor.locator(".modal").getByRole("button", { name: "Cancel" }).click();
    expect(trashCalls()).toHaveLength(0);
    await editor.getByRole("button", { name: "Trash originals" }).click();
    await editor.locator(".modal").getByRole("button", { name: "Move to trash" }).click();
    await editor.getByText("Originals in trash").waitFor({ timeout: 30_000 });
    expect(trashCalls()[0]!.payload).toEqual([null, 1, dedups, 3]);
    expect([...fake.trashed].sort()).toEqual([...dedups].sort());
    await editor.close();
    fake.trashed.clear();
    fake.calls.length = 0;

    // Paragraph: the scan does not show photos that already have a panorama, and says how many it left out.
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: panoramas, recheck: false } })).toMatchObject({ ok: true });
    const hiding = await scanFrame(page);
    await hiding.getByRole("button", { name: "Scan again" }).waitFor({ timeout: 120_000 });
    await hiding.getByText("1 already made").waitFor();
    expect(await hiding.locator(".cand").count()).toBe(0);
    await hiding.getByRole("button", { name: "Close" }).click();

    // Paragraph: Re-check all shows them again: make it again (it is marked already made, so it starts unticked).
    await page.locator("iframe").waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: panoramas, recheck: true } })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    await frame.getByRole("button", { name: "Scan again" }).waitFor({ timeout: 120_000 });
    await frame.locator(".cand input[type=checkbox]").check();
    await frame.getByRole("button", { name: "Create 1" }).click();
    await frame.locator(".modal").getByRole("button", { name: "Create" }).click();
    await frame.getByRole("button", { name: "Trash originals" }).waitFor({ timeout: 120_000 });
    const confirmTrash = async () => {
      await frame.getByRole("button", { name: "Trash originals" }).click();
      await frame.locator(".modal").getByRole("button", { name: "Move to trash" }).click();
    };

    // Paragraph: a panorama that cannot be found keeps its photos, without even trying to move them.
    fake.loseUploads = true;
    await confirmTrash();
    await frame.getByText("so its photos were not moved").waitFor({ timeout: 30_000 });
    expect(trashCalls()).toHaveLength(0);
    fake.loseUploads = false;

    // Paragraph: a photo that does not reach the trash stops the run and says so; the others are recorded.
    fake.refuseTrash.add(dedups[1]!);
    await confirmTrash();
    await frame.getByText("1 of 3 photos did not reach the trash").waitFor({ timeout: 30_000 });
    expect(await frame.getByText("Originals in trash").count()).toBe(0);
    fake.refuseTrash.clear();

    // Paragraph: the retry asks for what is left only, and the pan is gone from the library.
    await frame.getByRole("button", { name: "Trash originals" }).click();
    expect(await frame.locator(".modal h2").innerText()).toBe("Move 1 original to trash?");
    await frame.locator(".modal").getByRole("button", { name: "Move to trash" }).click();
    await frame.getByText("Originals in trash").waitFor({ timeout: 30_000 });
    expect(trashCalls().at(-1)!.payload).toEqual([null, 1, [dedups[1]], 3]);
    expect([...fake.trashed].sort()).toEqual([...dedups].sort());
    await frame.getByRole("button", { name: "Scan again" }).click();
    await frame.getByText("Nothing found.").waitFor({ timeout: 120_000 });
    expect(await frame.locator(".cand").count()).toBe(0);
    await frame.getByRole("button", { name: "Close" }).click();
    await page.close();
    fake.trashed.clear();
  });

  it("finds duplicates by looks, keeps the best, and moves the rest to trash", async () => {
    // Paragraph: four photos in this library are the same picture (three of them under other dates and names).
    const same = [photos[0]!, ...photos.filter((p) => ["AF1QipFAKELONE0000000", "AF1QipFAKEWRONGDATE00", "AF1QipFAKECUSTOM00000"].includes(p.mediaKey))];
    const before = fake.renditions;
    const { page, tabId } = await openPhotos();
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: { panorama: false, dates: false, duplicates: true }, recheck: false } })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    await frame.getByRole("button", { name: "Scan again" }).waitFor({ timeout: 120_000 });
    expect(await frame.getByRole("tab").count()).toBe(0); // one thing looked for: no tabs
    expect(fake.renditions).toBe(before); // detection does not touch the 800 px renditions

    // Paragraph: they group at 100%, and the oldest copy is the best one when nothing else differs.
    await frame.locator(".dup-group").first().waitFor();
    const group = frame.locator(".dup-group").filter({ has: frame.getByText("Best") }).first();
    expect(await group.locator(".dup-tile").count()).toBe(same.length);
    expect(await group.locator(".dup-tile.goes").count()).toBe(same.length - 1);
    expect(await frame.getByRole("button", { name: `Trash ${same.length - 1}` }).count()).toBe(1);

    // Paragraph: the last photo to keep can never be ticked.
    expect(await group.locator(".dup-tile").first().locator("input").isDisabled()).toBe(true);

    // Paragraph: Cancel moves nothing; confirming moves exactly the copies, with the read-back, and they leave the list.
    const calls = () => fake.calls.filter((c) => c.rpc === "XwAOJf").length;
    const start = calls();
    await frame.getByRole("button", { name: `Trash ${same.length - 1}` }).click();
    await frame.locator(".modal").getByRole("button", { name: "Cancel" }).click();
    expect(calls()).toBe(start);
    await frame.getByRole("button", { name: `Trash ${same.length - 1}` }).click();
    await frame.locator(".modal").getByRole("button", { name: "Move to trash" }).click();
    await frame.getByText("None at this similarity.").waitFor({ timeout: 30_000 });
    expect([...fake.trashed].sort()).toEqual(same.slice(1).map((p) => p.dedupKey).sort());
    expect(fake.trashed.has(same[0]!.dedupKey)).toBe(false);
    await frame.getByRole("button", { name: "Close" }).click();
    await page.close();
    fake.trashed.clear();
  });

  it("opens Split for several photos in a tab and analyses them", async () => {
    const { page, tabId } = await openPhotos();
    const keys = photos.slice(0, 2).map((p) => p.mediaKey);
    expect(await asExtensionPage({ type: "panel.openTool", tool: "split", tabId, mediaKeys: keys })).toMatchObject({ ok: true });
    const split = await pageNamed("split.html");
    await split.waitForSelector(".filmstrip");
    expect(await split.locator(".film").count()).toBe(2);
    await expect.poll(async () => split.locator(".film.ready, .film.saved").count(), { timeout: 60_000 }).toBe(2);
    expect(await split.locator(".error-box").count()).toBe(0);
    await split.close();
    await page.close();
  });

  it("opens the panorama editor in a tab, previews, and Close closes the tab", async () => {
    const { page, tabId } = await openPhotos();
    const keys = photos.slice(0, 3).map((p) => p.mediaKey);
    expect(await asExtensionPage({ type: "panel.openTool", tool: "panorama", tabId, mediaKeys: keys })).toMatchObject({ ok: true });
    const editor = await pageNamed("panorama.html");
    await editor.waitForSelector(".pano-frame img", { timeout: 120_000 });
    expect(await editor.locator(".error-box").count()).toBe(0);
    const closed = editor.waitForEvent("close");
    // The page goes away during the click, which Playwright may report; the close event is the proof.
    await editor.getByRole("button", { name: "Close" }).click({ noWaitAfter: true }).catch(() => {});
    await closed;
    await page.close();
  });

  it("edits a group inside the modal, saves it to Photos, and goes back to the results", async () => {
    // Paragraph: find the group.
    const { page, tabId } = await openPhotos();
    const uploadsBefore = fake.uploads.length;
    const pagesBefore = context.pages().length;
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: panoramas, recheck: true } })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    await frame.getByRole("button", { name: "Scan again" }).waitFor({ timeout: 120_000 });

    // Paragraph: Edit stays in the modal, and Back returns without saving.
    await frame.getByRole("button", { name: "Edit…" }).click();
    await frame.locator(".pano-frame img").waitFor({ timeout: 120_000 });
    expect(context.pages().length).toBe(pagesBefore);
    await frame.getByRole("button", { name: "← Back" }).click();
    await frame.locator(".cand").waitFor();
    expect(fake.uploads.length).toBe(uploadsBefore);

    // Paragraph: saving from the editor reaches Photos, and the group then counts as created.
    await frame.getByRole("button", { name: "Edit…" }).click();
    await frame.locator(".pano-frame img").waitFor({ timeout: 120_000 });
    await frame.getByRole("button", { name: "Save to Google Photos" }).click();
    await frame.locator(".modal").getByRole("button", { name: "Save" }).click();
    await frame.getByText("Saved to Google Photos").waitFor({ timeout: 120_000 });
    expect(fake.uploads.length).toBe(uploadsBefore + 1);
    await frame.getByRole("button", { name: "← Back" }).click();
    await frame.locator(".cand.created").waitFor();
    await page.close();
  });
});
