/**
 * End-to-end: the real build in real Chromium, against a fake Google backend (fake-photos.ts).
 * Covers what the editor sandboxes cannot, because they fake the extension APIs: message
 * sender checks, the modal iframe under a strict page CSP, and WebAssembly under the
 * extension's own CSP. Requires `npm run build` and `npx playwright install chromium`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ExifReader from "exifreader";
import { chromium, type BrowserContext, type Frame, type Page, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePhotos, makeOverlappingShots, type FakePhoto } from "./fake-photos.js";

const DIST = path.resolve("dist");
const T0 = Date.UTC(2024, 6, 14, 9, 0, 0);

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
    context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] });
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    extensionId = new URL(sw.url()).host;

    // Paragraph: a 3-shot pan, plus a lone photo much later.
    const scratch = await context.newPage();
    const shots = await makeOverlappingShots(scratch, 3);
    await scratch.close();
    photos = shots.map((jpeg, i) => ({ mediaKey: `AF1QipFAKE${i}000000000`, dedupKey: `dedupFAKE${i}0000`, takenAtMs: T0 + i * 3000, jpeg, width: 800, height: 600 }));
    photos.push({ mediaKey: "AF1QipFAKELONE0000000", dedupKey: "dedupFAKELONE", takenAtMs: T0 + 86_400_000, jpeg: shots[0]!, width: 800, height: 600 });
    photos.push({ mediaKey: "AF1QipFAKEWRONGDATE00", dedupKey: "dedupFAKEWRONGDATE", takenAtMs: T0 + 2 * 86_400_000, jpeg: shots[0]!, width: 800, height: 600, fileName: "IMG-20190512-WA0001.jpg" });
    photos.push({ mediaKey: "AF1QipFAKECUSTOM00000", dedupKey: "dedupFAKECUSTOM", takenAtMs: T0 + 3 * 86_400_000, jpeg: shots[0]!, width: 800, height: 600, fileName: "HOLIDAY_12-05-2018_beach.jpg" });
    fake = new FakePhotos(photos);
    await fake.install(context);
  });

  afterAll(async () => {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  });

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
    const reply = await page.evaluate((m) => chrome.runtime.sendMessage(m), message);
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
    expect(await asExtensionPage({ type: "panel.openScan", tabId, mediaKeys: [] })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    expect(page.url()).toBe("https://photos.google.com/"); // a modal, not a new tab

    // Paragraph: scan the whole library: the 3-shot pan is found, the lone photo is not.
    await frame.getByRole("radio", { name: "Whole library" }).click();
    await frame.getByRole("button", { name: "Scan", exact: true }).click();
    await frame.locator(".progress-line").first().waitFor();
    await frame.locator(".cand").first().waitFor({ timeout: 120_000 });
    await frame.getByRole("button", { name: "New scan" }).waitFor({ timeout: 60_000 });
    expect(await frame.locator(".cand").count()).toBe(1);
    expect(await frame.locator(".cand .strip img").count()).toBe(3);
    expect(await frame.locator(".error-box").count()).toBe(0);

    // Paragraph: minimize keeps it alive; the chip's click (closed shadow root) is not reachable, so restore by reopening.
    await frame.getByRole("button", { name: "Minimize" }).click();
    expect(await asExtensionPage({ type: "panel.openScan", tabId, mediaKeys: [] })).toMatchObject({ ok: true });
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
    expect(await asExtensionPage({ type: "panel.openScan", tabId, mediaKeys: [] })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    const before = fake.renditions;
    await frame.getByRole("radio", { name: "Whole library" }).click();
    await frame.getByRole("button", { name: "Scan", exact: true }).click();
    await frame.getByRole("button", { name: "New scan" }).waitFor({ timeout: 60_000 });
    expect(await frame.locator(".cand").count()).toBe(1);
    expect(await frame.locator(".cand .strip img").count()).toBe(3);
    expect(await frame.locator(".cand-preview img").count()).toBe(1);
    expect(await frame.locator(".status-bar").innerText()).toContain("6 already checked");
    expect(fake.renditions).toBe(before);

    // Paragraph: "Re-check all" downloads the thumbnails again.
    await frame.getByRole("button", { name: "New scan" }).click();
    await frame.getByRole("radio", { name: "Whole library" }).click();
    await frame.getByLabel("Re-check all").check();
    await frame.getByRole("button", { name: "Scan", exact: true }).click();
    await frame.getByRole("button", { name: "New scan" }).waitFor({ timeout: 120_000 });
    expect(fake.renditions).toBeGreaterThan(before);
    await frame.getByRole("button", { name: "Close" }).click();
    await page.close();
  });

  it("refuses a scan frame that was not opened through the extension", async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/scan.html?tab=1&email=a@b.com&sel=forged`);
    await page.waitForSelector(".error-box");
    expect(await page.locator(".error-box").innerText()).toContain("Start the scan from the Pixlixir menu");
    await page.close();
  });

  it("refuses a scan handed over for another account", async () => {
    await sw.evaluate(() => chrome.storage.session.set({ "pixlixir.scanSelection.other": { accountEmail: "second@example.com", mediaKeys: [] } }));
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
    await settings.getByRole("button", { name: "Add" }).click();
    await settings.getByText("HOLIDAY_dd-mm-yyyy_*.*").waitFor();
    await settings.reload();
    await settings.getByText("HOLIDAY_dd-mm-yyyy_*.*").waitFor();
    await settings.goto(`chrome-extension://${extensionId}/settings.html?email=second@example.com`);
    await settings.getByText("*-yyyymmdd-WA*.*").waitFor();
    expect(await settings.getByText("HOLIDAY_dd-mm-yyyy_*.*").count()).toBe(0);
    await settings.close();

    // Paragraph: only the date check, so no stitching. Both names are found, from different formats.
    const { page, tabId } = await openPhotos();
    expect(await asExtensionPage({ type: "panel.openScan", tabId, mediaKeys: [] })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    await frame.getByRole("radio", { name: "Whole library" }).click();
    await frame.getByRole("checkbox", { name: "Panoramas" }).uncheck();
    await frame.getByRole("button", { name: "Scan", exact: true }).click();
    await frame.locator(".date-rows li").nth(1).waitFor({ timeout: 60_000 });
    await frame.getByRole("button", { name: "New scan" }).waitFor();
    expect(await frame.locator(".date-rows li").count()).toBe(2);

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
    await frame.getByRole("button", { name: "Close" }).click();
    await page.close();
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
    expect(await asExtensionPage({ type: "panel.openScan", tabId, mediaKeys: [] })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    await frame.getByRole("radio", { name: "Whole library" }).click();
    await frame.getByRole("button", { name: "Scan", exact: true }).click();
    await frame.getByRole("button", { name: "New scan" }).waitFor({ timeout: 120_000 });

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
