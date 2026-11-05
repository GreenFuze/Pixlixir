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

const DIST = path.resolve(process.env.PIXLIXIR_DIST ?? "dist");
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
    expect(await frame.getByRole("tab").allInnerTexts()).toEqual(["Panoramas 1", expect.stringMatching(/^Wrong dates \d+$/)]);
    await frame.getByRole("tab", { name: /Panoramas/ }).click();
    expect(await frame.locator(".cand").count()).toBe(1);
    expect(await frame.locator(".cand .strip img").count()).toBe(3);
    expect(await frame.locator(".cand-preview img").count()).toBe(1);
    expect(await frame.locator(".date-rows").count()).toBe(0);
    expect(await frame.locator("footer").count()).toBe(1);
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
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: { panorama: false, dates: true, duplicates: false }, recheck: false } })).toMatchObject({ ok: true });
    const frame = await scanFrame(page);
    await frame.locator(".date-rows li").nth(1).waitFor({ timeout: 60_000 });
    await frame.getByRole("button", { name: "Scan again" }).waitFor();
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
    expect(await frame.locator(".date-rows").innerText()).toContain("IMG-20190512-WA0001.jpg");
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

    // Paragraph: the scan: make it again (it is marked already made, so it starts unticked).
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: panoramas, recheck: false } })).toMatchObject({ ok: true });
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
    expect(await asExtensionPage({ type: "panel.openScan", tabId, plan: { scope: LIBRARY, detectors: panoramas, recheck: false } })).toMatchObject({ ok: true });
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
