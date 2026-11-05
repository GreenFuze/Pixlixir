# ✦ Pixlixir

**Make the Google Photos you already use more powerful.** Pixlixir is a Chrome extension
that adds tools Google Photos lacks on desktop — **Split into Photos** (turn one scan of an
album page into separate, straightened photos) and **Create panorama** (stitch overlapping
photos, ICE-style), saved right back into your library next to the originals.

> Pixlixir is not affiliated with Google. It works through your own signed-in
> photos.google.com session using **undocumented** web interfaces, which may change or
> break at any time. See [the risk assessment](docs/security/RISK-ASSESSMENT.md).

## What works today

| Feature | Status |
|---|---|
| Account detection, side panel, in-page launcher, selection tracking | ✅ built |
| **Split into Photos**: auto-detect prints (also on patterned cloth / album pages, with perspective), adjust/add/remove/rotate, save as new items dated like the scan | ✅ built — protocol steps verified live, awaiting your end-to-end test |
| **Fix** (separate feature, hosted by Split for now): colour restore (or keep original tones), lighting & shadow correction measured from the surface around the prints, glare reduction (auto hotspots + Glare brush), dust & scratches, Repair brush, Protect brush, sharpen, before/after | ✅ built — local processing; a standalone "Fix a photo" tool is planned |
| **Create panorama**: select 2–40 overlapping photos → automatic alignment, projections (spherical, cylindrical, perspective, Panini, …), horizon straightening, exposure compensation, seamless blending, crop or fill edges, "flat surface" mode for posters/documents, save at full resolution (≤ 60 MP) | ✅ built — OpenCV + OpenStitching running locally (ADR-0005); verified in a sandbox, awaiting your test |
| **Scan library** for panoramas, in a modal over Google Photos with live progress: date range, album, selection or whole library → groups of overlapping photos with previews → create the ones you pick in bulk. Each panorama gets the first photo's date and EXIF, the photos' location and description, and lands in the same albums | ✅ built — verified in a sandbox; library/album/description calls verified live; awaiting your test |
| Download results locally | ✅ built |
| Standalone Fix, AI Studio, duplicates, metadata repair, HDR/focus stacking, video, vault, agent API | 🗺️ planned — see [FEATURES.md](docs/roadmap/FEATURES.md) |

Originals are never modified. Nothing is deleted. All processing runs locally in your browser.

## Install (developer mode)

```bash
npm ci
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
choose the `dist/` folder. Open https://photos.google.com and look for the **✦ Pixlixir**
chip in the bottom-right corner. Step-by-step tests: [Split](docs/testing/MANUAL-TEST-split.md) ·
[Panorama](docs/testing/MANUAL-TEST-panorama.md) · [Scan library](docs/testing/MANUAL-TEST-scan.md).

The first build downloads the panorama engine (Pyodide, OpenCV, OpenStitching — ~26 MB,
pinned and sha256-verified, ~27 MB with Pillow for EXIF) into `vendor/` and ships it inside `dist/`.

## Develop

| Command | Does |
|---|---|
| `npm run build` / `npm run watch` | Build the unpacked extension into `dist/` |
| `npm test` | Unit, contract and panorama-engine integration tests (Vitest; vendors the engine first) |
| `npm run test:e2e` | The real build in real Chromium against a fake Google backend (Playwright; first run `npx playwright install chromium`) |
| `npm run vendor` | Download/verify the pinned panorama engine files into `vendor/pyodide/` |
| `npm run dev:serve` | Serve the repo with the extension's CSP for the editor sandboxes ([tools/dev](tools/dev/README.md)) |
| `npm run typecheck` | Strict TypeScript |
| `npm run check` | All of the above |
| `npm run build:probe` | Build the live protocol probe ([tools/live-probe](tools/live-probe/probe.ts)) |
| `npm run dev:split -- captures/<scan>.jpg` | Run detection + fixes on a local image and write debug images to `captures/debug/` (see [tools/dev](tools/dev/README.md)) |

## Docs

- Product: [PRD](docs/product/PRD.md) · [Master feature list](docs/roadmap/FEATURES.md) · [Roadmap](docs/roadmap/ROADMAP.md)
- UX: [UX spec & wireframes](docs/ux/UX-SPEC.md)
- Architecture: [Overview](docs/architecture/ARCHITECTURE.md) · [ADRs](docs/architecture/adr/)
- Feasibility: [Google Photos protocol evidence](docs/feasibility/google-photos-protocol.md) · [Register](docs/feasibility/FEASIBILITY-REGISTER.md)
- Security: [Risk assessment](docs/security/RISK-ASSESSMENT.md)
- Research: [Competitors](docs/research/COMPETITORS.md) · [Mobile parity](docs/research/MOBILE-PARITY.md)

## License & attribution

Licensed under the [Apache License 2.0](LICENSE). If you use, fork or redistribute Pixlixir,
you must keep the [NOTICE](NOTICE) file and credit:

> Based on Pixlixir by GreenFuze — https://github.com/GreenFuze/Pixlixir
