<p align="center">
  <img src="docs/assets/logo.png" width="96" alt="Pixlixir logo">
</p>

<h1 align="center">Pixlixir</h1>

<p align="center">
  <b>The power tools Google Photos forgot to put on desktop.</b><br>
  Find duplicate photos, stitch panoramas, split scanned album pages, fix wrong dates and edit with AI,
  right inside photos.google.com. Free and open source.
</p>

<p align="center">
  <a href="https://github.com/GreenFuze/Pixlixir/releases/latest"><img alt="Download" src="https://img.shields.io/github/v/release/GreenFuze/Pixlixir?include_prereleases&label=download&color=6b4fbb"></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue"></a>
  <img alt="Chrome extension" src="https://img.shields.io/badge/Chrome-extension-4285F4?logo=googlechrome&logoColor=white">
  <img alt="Runs locally" src="https://img.shields.io/badge/processing-100%25%20local-2ea44f">
  <a href="https://github.com/GreenFuze/Pixlixir/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/GreenFuze/Pixlixir/actions/workflows/ci.yml/badge.svg"></a>
</p>

---

You have 100,000 photos in Google Photos. Some are there twice. Some say they were taken in 2022
when they were taken in 2009. Your scanned album pages hold four photos each, and the panorama you
shot on holiday is still five separate pictures. Google Photos on the web can't fix any of that.

**Pixlixir can.** It's a Chrome extension that adds a side panel to Google Photos and works on the
library you already have. No export, no re-upload, no new account.

## ✨ What it does

### 🔍 Find and remove duplicate photos
Scan your whole Google Photos library, an album, a date range or a selection for photos that
**look the same**, even at different sizes or after recompression. Choose how similar is similar
enough, see every group side by side, and keep the best copy (highest resolution first). The kept
photo joins the copies' albums. The rest go to **Trash**, never deleted for good.

### 🌄 Create panoramas from your photos
Pick 2 to 40 overlapping photos, or let a library scan **find panorama sequences for you**, and
stitch them into one seamless image: automatic alignment, spherical, cylindrical, perspective and
Panini projections, horizon straightening, exposure blending, crop or fill the edges. Works for
posters and documents shot in parts, too. The panorama keeps the first photo's date, location,
description and albums.

### 🖼️ Split scanned album pages into separate photos
Scanned a whole album page, or used a flatbed scanner with several prints at once? Pixlixir
**detects each print**, straightens it, corrects the perspective and saves every photo as its own
item, dated like the scan. Then **restore old photos**: faded colours, uneven lighting, glare, dust
and scratches.

### 📅 Fix wrong photo dates
WhatsApp, scanners and old exports leave photos with the wrong date. Pixlixir reads the real date
from **file names** (`IMG-20190714-WA0003.jpg`, and any format you add) and from the file's own
EXIF data. For saved copies it **looks for the original photo** in your library and offers its date.
Review every change, apply in bulk, undo if you change your mind.

### 🪄 Edit with AI, Magic Eraser style
Brush over what you want gone or changed, then pick **Erase, Fix, Unblur, Enhance or Replace**.
Pixlixir prepares the request in the AI service you already use (ChatGPT, Gemini, Grok or one you
add) or in a local engine like IOPaint on your own computer. No API keys. You bring the result
back, compare it, and save it as a new photo.

### ⚡ Bulk operations
One scan, many checks: duplicates, panoramas and wrong dates in a single pass over your library,
with live progress and time left. Results are saved, so the next scan only checks new photos.

## 🔒 Private by design

- **Your photos stay in your browser.** Duplicates, panoramas, splitting and date fixes all run
  locally on your computer. There are no Pixlixir servers.
- **Nothing is changed without you.** You review everything first. Results are saved as **new**
  items next to the originals, and original files are never modified.
- **Deletes go to Trash.** Google Photos keeps them for 60 days.
- **Open source.** Every line is here to read.

## 🚀 Install

Pixlixir is not in the Chrome Web Store yet. Installing it takes a minute:

1. **Download** `pixlixir-vX.Y.Z.zip` from the [latest release](https://github.com/GreenFuze/Pixlixir/releases/latest).
2. **Unzip** it into a folder you'll keep (Chrome loads the extension from there).
3. Open **`chrome://extensions`**, switch on **Developer mode** (top right), click **Load unpacked**
   and choose the unzipped folder.
4. Open **[photos.google.com](https://photos.google.com)** and click the **✦ Pixlixir** chip in the
   bottom-right corner, or the Pixlixir icon in the toolbar.

Needs Chrome 116 or newer. Other Chromium browsers (Edge, Brave) may work but aren't tested yet.

**Updating:** download the new zip, replace the folder's contents, and press ↻ on Pixlixir's card
in `chrome://extensions`. Your settings and saved scans are kept.

## ⚠️ Good to know

- **Early preview (v0.x).** Every feature is tested against a stand-in Google Photos, and testing on
  a real 100,000-photo library is under way. Expect rough edges, and please [open an issue](https://github.com/GreenFuze/Pixlixir/issues) when something breaks.
- **Not affiliated with Google.** Pixlixir works through your own signed-in Google Photos session,
  using the same web interfaces the site uses. They're undocumented and can change, so a Google
  update may break a feature until Pixlixir catches up. See the [risk assessment](docs/security/RISK-ASSESSMENT.md).
- **Desktop Chrome only.** There's no phone version.

## ❓ FAQ

**Does Google Photos have a duplicate finder?**
Not for photos that merely look alike. Google skips identical uploads, but resized copies, edited
copies and re-saved WhatsApp images stay. Pixlixir finds them by how they look.

**Can I make a panorama in Google Photos on my computer?**
Google Photos only creates panoramas automatically, on its own schedule. Pixlixir lets you pick
the photos and the projection, and save the result right away.

**Is it free?**
Yes, under the Apache 2.0 license. AI services you choose to use have their own terms and limits.

**Does it upload my photos anywhere?**
Only back to your own Google Photos, when you save a result. When you choose Edit with AI, the
photo goes to the AI service you picked, in your own signed-in tab.

## 🛠️ Build from source

```bash
npm ci
npm run build
```

Then **Load unpacked** the `dist/` folder. The first build downloads the panorama engine
(Pyodide, OpenCV and OpenStitching, about 27 MB, pinned and sha256-verified).

| Command | Does |
|---|---|
| `npm run build` / `npm run watch` | Build the unpacked extension into `dist/` |
| `npm test` | Unit, contract and panorama-engine tests (Vitest) |
| `npm run test:e2e` | The real build in real Chromium against a fake Google backend (Playwright; first run `npx playwright install chromium`) |
| `npm run typecheck` | Strict TypeScript |
| `npm run check` | All of the above |

Manual test guides: [Split](docs/testing/MANUAL-TEST-split.md) · [Panorama](docs/testing/MANUAL-TEST-panorama.md) ·
[Scan library](docs/testing/MANUAL-TEST-scan.md) · [Duplicates](docs/testing/MANUAL-TEST-duplicates.md) ·
[Wrong dates](docs/testing/MANUAL-TEST-dates.md) · [Edit](docs/testing/MANUAL-TEST-edit.md)

**Docs:** [Features and status](docs/roadmap/FEATURES.md) · [Roadmap](docs/roadmap/ROADMAP.md) ·
[Architecture](docs/architecture/ARCHITECTURE.md) · [ADRs](docs/architecture/adr/) ·
[Protocol evidence](docs/feasibility/google-photos-protocol.md) · [Risk assessment](docs/security/RISK-ASSESSMENT.md)

## 🤝 Contributing

Bug reports, ideas and pull requests are welcome. If Pixlixir saved you an afternoon of
clicking, a ⭐ helps other people find it.

## License

[Apache License 2.0](LICENSE). If you use, fork or redistribute Pixlixir, keep the [NOTICE](NOTICE)
file and credit: *Based on Pixlixir by GreenFuze — https://github.com/GreenFuze/Pixlixir*

<sub>Keywords: Google Photos extension, Google Photos duplicate finder, remove duplicate photos,
delete similar photos, Google Photos panorama maker, photo stitching, split scanned photos, photo
scanner, album page splitter, restore old photos, fix photo dates, wrong date Google Photos, EXIF
date fixer, WhatsApp photo dates, bulk edit Google Photos, Magic Eraser for desktop, AI photo
editor, Google Photos web tools, Chrome extension, photo library cleanup.</sub>

<sub>Google Photos is a trademark of Google LLC. Pixlixir is not affiliated with, endorsed by, or sponsored by Google.</sub>
