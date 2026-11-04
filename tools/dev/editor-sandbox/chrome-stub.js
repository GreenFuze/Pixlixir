// Dev-only stand-in for chrome.runtime / chrome.tabs so the split editor can run
// as a normal web page against a local image. Nothing here talks to Google.
(() => {
  const params = new URLSearchParams(location.search);
  const imgUrl = params.get("img");
  const uploads = [];
  const ok = (value) => ({ ok: true, value });
  const toBase64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

  async function photos(msg) {
    if (msg.type === "photos.getItem") {
      return ok({ ref: { accountEmail: msg.expectedEmail, mediaKey: msg.mediaKey }, dedupKey: "sandbox", type: "photo", width: 0, height: 0, takenAtMs: Date.UTC(2009, 5, 1), timezoneOffsetMs: 0, baseUrl: "sandbox", fileName: imgUrl.split("/").pop(), sizeBytes: null });
    }
    if (msg.type === "photos.downloadOriginal") {
      const res = await fetch(imgUrl);
      const blob = await res.blob();
      return ok({ bytesBase64: toBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type || "image/jpeg" });
    }
    if (msg.type === "photos.uploadPhoto") {
      await new Promise((r) => setTimeout(r, 400));
      uploads.push({ fileName: msg.fileName, bytes: msg.bytesBase64.length });
      window.__sandboxUploads = uploads;
      const key = `SANDBOX-${uploads.length}`;
      return ok({ ref: { accountEmail: msg.expectedEmail, mediaKey: key }, dedupKey: key, width: 0, height: 0, webUrl: `#sandbox-upload-${uploads.length}` });
    }
    return { ok: false, error: { code: "NO_HANDLER", message: `sandbox: unhandled ${msg.type}` } };
  }

  window.chrome = {
    runtime: {
      id: "sandbox",
      sendMessage: async (msg) => (msg.type === "photos.resolveTab" ? ok({ tabId: 1 }) : { ok: false, error: { code: "NO_HANDLER", message: `sandbox: unhandled ${msg.type}` } }),
      getURL: (p) => `/dist/${p}`,
    },
    tabs: { sendMessage: (_tabId, msg) => photos(msg) },
  };
})();
