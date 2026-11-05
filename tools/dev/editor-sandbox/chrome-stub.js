// Dev-only stand-in for chrome.runtime / chrome.tabs / chrome.storage so the editors and the
// library scan can run as normal web pages against local images. Nothing here talks to Google.
//
// Editors: one ?img= per media key (same order as ?media=k1,k2,…); a single img serves every key.
// Scan: a fake library built from captures/pano (gitignored test images from opencv_extra):
//   boat1-6 and budapest1-6 are two pans (shots 3 s apart), newspaper1-4 a flat subject,
//   sample-3prints.jpg a lone photo. Album "Boat trip" holds the boats; boat1 has a
//   description and a location.
(() => {
  const params = new URLSearchParams(location.search);
  const images = params.getAll("img");
  const mediaKeys = (params.get("media") ?? "").split(",");
  const imageFor = (mediaKey) => images[Math.max(0, mediaKeys.indexOf(mediaKey))] ?? images[0];
  const uploads = [];
  const albumAdds = [];
  const descriptions = [];
  const ok = (value) => ({ ok: true, value });
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const toBase64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

  // Paragraph: the fake library (newest first, like lcxiM).
  const T = Date.UTC(2024, 6, 14, 9, 0, 0);
  const entry = (name, file, t, w, h) => ({ mediaKey: `AF1QipSANDBOX${name.toUpperCase().padEnd(10, "0")}`, dedupKey: `dedup-${name}-sandbox`, type: "photo", width: w, height: h, takenAtMs: t, timezoneOffsetMs: 7_200_000, baseUrl: `https://lh3.googleusercontent.com/sandbox/${name}`, location: null, file });
  const library = [
    ...[1, 2, 3, 4, 5, 6].map((i) => entry(`boat${i}`, `/captures/pano/boat${i}.jpg`, T + i * 3000, 2000, 1500)),
    ...[1, 2, 3, 4, 5, 6].map((i) => entry(`budapest${i}`, `/captures/pano/budapest${i}.jpg`, T + 3600_000 + i * 3000, 1500, 1000)),
    ...[1, 2, 3, 4].map((i) => entry(`newspaper${i}`, `/captures/pano/newspaper${i}.jpg`, T + 7200_000 + i * 4000, 1500, 2000)),
    entry("prints", "/captures/sample-3prints.jpg", T + 9000_000, 3000, 2000),
    // The same picture again: a smaller copy days later, and a third.
    entry("boatcopya", "/captures/pano/boat1.jpg", T + 5 * 86_400_000, 1000, 750),
    entry("boatcopyb", "/captures/pano/boat1.jpg", T + 9 * 86_400_000, 1600, 1200),
  ].sort((a, b) => b.takenAtMs - a.takenAtMs);
  const byKey = new Map(library.map((i) => [i.mediaKey, i]));
  const albums = [{ mediaKey: "AF1QipSANDBOXALBUMBOAT", title: "Boat trip", shared: false }];
  const albumItems = { AF1QipSANDBOXALBUMBOAT: library.filter((i) => i.file.includes("boat")).map((i) => i.mediaKey) };
  const details = { [library.find((i) => i.file.endsWith("boat1.jpg")).mediaKey]: { description: "Harbour, morning", location: { latitude: 47.4979, longitude: 19.0402 } } };
  const listed = ({ file, ...item }) => item;
  const PAGE = 5;
  const page = (all, token) => { const start = token ? Number(token) : 0; return { items: all.slice(start, start + PAGE), next: start + PAGE < all.length ? String(start + PAGE) : null }; };

  const sandboxDates = new Map();
  const sandboxTrash = new Set();

  async function thumbnail(file, side) {
    const blob = await (await fetch(file)).blob();
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.85 })).arrayBuffer());
  }

  async function photos(msg) {
    // Paragraph: item reads (library items first, then the editor's ?media/?img pairs).
    const lib = msg.mediaKey ? byKey.get(msg.mediaKey) : undefined;
    if (msg.type === "photos.getItem") {
      if (lib) return ok({ ref: { accountEmail: msg.expectedEmail, mediaKey: lib.mediaKey }, dedupKey: lib.dedupKey, type: "photo", width: lib.width, height: lib.height, takenAtMs: lib.takenAtMs, timezoneOffsetMs: lib.timezoneOffsetMs, baseUrl: lib.baseUrl, fileName: lib.file.split("/").pop(), sizeBytes: null });
      const index = Math.max(0, mediaKeys.indexOf(msg.mediaKey));
      return ok({ ref: { accountEmail: msg.expectedEmail, mediaKey: msg.mediaKey }, dedupKey: "sandbox", type: "photo", width: 0, height: 0, takenAtMs: Date.UTC(2009, 5, 1) + index * 1000, timezoneOffsetMs: 0, baseUrl: "sandbox", fileName: imageFor(msg.mediaKey).split("/").pop(), sizeBytes: null });
    }
    if (msg.type === "photos.getItemDetails") {
      const d = details[msg.mediaKey] ?? { description: "", location: null };
      const inAlbums = albums.filter((a) => albumItems[a.mediaKey].includes(msg.mediaKey));
      return ok({ mediaKey: msg.mediaKey, dedupKey: lib?.dedupKey ?? "sandbox", description: d.description, albums: inAlbums, location: d.location, camera: null });
    }
    if (msg.type === "photos.downloadOriginal") {
      const res = await fetch(lib ? lib.file : imageFor(msg.mediaKey));
      const blob = await res.blob();
      return ok({ bytesBase64: toBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type || "image/jpeg" });
    }

    // Paragraph: listings.
    if (msg.type === "photos.listLibrary") {
      const all = library.filter((i) => msg.startMs === null || i.takenAtMs <= msg.startMs).map(listed);
      return ok(page(all, msg.page));
    }
    if (msg.type === "photos.listAlbums") return ok(page(albums, msg.page));
    if (msg.type === "photos.listAlbumItems") return ok(page((albumItems[msg.albumKey] ?? []).map((k) => listed(byKey.get(k))), msg.page));
    if (msg.type === "photos.thumbnail") {
      const item = library.find((i) => i.baseUrl === msg.baseUrl);
      if (!item) return fail("MEDIA_FETCH_FAILED", "sandbox: unknown thumbnail");
      return ok({ bytesBase64: toBase64(await thumbnail(item.file, msg.maxSide)), mimeType: "image/jpeg" });
    }

    // Paragraph: file names: the Budapest shots pretend to be WhatsApp photos of 2019 (wrong dates to review).
    if (msg.type === "photos.readItemInfo") {
      return ok(msg.mediaKeys.flatMap((k) => {
        const item = byKey.get(k);
        if (!item) return [];
        const n = item.file.split("/").pop();
        const changed = sandboxDates.get(item.dedupKey);
        return [{ mediaKey: k, fileName: /budapest/.test(n) ? n.replace(/budapest(\d)\.jpg/, "IMG-20190512-WA000$1.jpg") : n, sizeBytes: 2_000_000, takenAtMs: changed?.takenAtMs ?? item.takenAtMs, timezoneOffsetMs: changed?.timezoneOffsetMs ?? item.timezoneOffsetMs }];
      }));
    }
    if (msg.type === "photos.moveToTrash") { for (const k of msg.dedupKeys) sandboxTrash.add(k); return ok(null); }
    if (msg.type === "photos.listTrash") return ok({ items: [...sandboxTrash], next: null });
    if (msg.type === "photos.setDates") { for (const c of msg.changes) sandboxDates.set(c.dedupKey, c); return ok(null); }

    // Paragraph: writes go to in-page records only.
    if (msg.type === "photos.uploadPhoto") {
      await new Promise((r) => setTimeout(r, 400));
      uploads.push({ fileName: msg.fileName, bytes: msg.bytesBase64.length, takenAtMs: msg.takenAtMs ?? null, bytesBase64Head: msg.bytesBase64.slice(0, 200000) });
      window.__sandboxUploads = uploads;
      const key = `AF1QipSANDBOXUPLOAD${uploads.length}`;
      return ok({ ref: { accountEmail: msg.expectedEmail, mediaKey: key }, dedupKey: `dedup-upload-${uploads.length}`, width: 0, height: 0, webUrl: `#sandbox-upload-${uploads.length}` });
    }
    if (msg.type === "photos.addToAlbum") { albumAdds.push({ mediaKeys: msg.mediaKeys, album: msg.album.title }); window.__sandboxAlbumAdds = albumAdds; return ok(null); }
    if (msg.type.startsWith("modal.")) { (window.__sandboxModal ??= []).push(msg); return ok(null); }
    if (msg.type === "photos.setDescription") { descriptions.push({ dedupKey: msg.dedupKey, description: msg.description }); window.__sandboxDescriptions = descriptions; return ok(null); }
    return fail("NO_HANDLER", `sandbox: unhandled ${msg.type}`);
  }

  // Paragraph: session storage holds a pretend selection (all newspaper shots + the lone photo) under id "sandbox".
  const accountEmail = params.get("email");
  const plan = (scope) => ({ accountEmail, plan: { scope, detectors: { panorama: true, dates: true, duplicates: true }, recheck: false } });
  const session = { "pixlixir.scanSelection.sandbox": plan({ kind: "selection", mediaKeys: library.filter((i) => /newspaper|prints/.test(i.file)).map((i) => i.mediaKey) }), "pixlixir.scanSelection.none": plan({ kind: "library" }) };

  window.chrome = {
    runtime: {
      id: "sandbox",
      sendMessage: async (msg) => {
        if (msg.type === "photos.resolveTab") return ok({ tabId: 1 });
        if (msg.type === "panel.openTool") { window.__sandboxOpenedTool = msg; return ok({ editorTabId: 2 }); }
        if (msg.type === "panel.openSettings") { window.__sandboxOpenedSettings = msg; return ok(null); }
        if (msg.type === "panel.accounts") return ok({ emails: ["dev@example.com", "second@example.com"] });
        return fail("NO_HANDLER", `sandbox: unhandled ${msg.type}`);
      },
      getURL: (p) => `/dist/${p}`,
    },
    tabs: { sendMessage: (_tabId, msg) => photos(msg) },
    storage: { local: { get: async (k) => { const v = localStorage.getItem(k); return v === null ? {} : { [k]: JSON.parse(v) }; }, set: async (o) => { for (const [k, v] of Object.entries(o)) localStorage.setItem(k, JSON.stringify(v)); } }, session: { get: async (k) => ({ [k]: session[k] }), set: async (o) => Object.assign(session, o), remove: async (k) => { delete session[k]; } } },
  };
})();
