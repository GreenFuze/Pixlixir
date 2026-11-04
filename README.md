# ✦ Pixlixir

**Make the Google Photos you already use more powerful.** Pixlixir is a Chrome extension
that adds tools Google Photos lacks on desktop — starting with **Split into Photos**: turn
one scan of an album page into separate, straightened photos, saved right back into your
library next to the original.

> Pixlixir is not affiliated with Google. It works through your own signed-in
> photos.google.com session using **undocumented** web interfaces, which may change or
> break at any time. See [the risk assessment](docs/security/RISK-ASSESSMENT.md).

## What works today

| Feature | Status |
|---|---|
| Account detection, side panel, in-page launcher, selection tracking | ✅ built |
| **Split into Photos**: auto-detect prints, adjust/add/remove/rotate, save as new items dated like the scan | ✅ built — protocol steps verified live, awaiting your end-to-end test |
| Download split results locally | ✅ built |
| Restore, AI Studio, duplicates, metadata repair, panoramas, video, vault, agent API | 🗺️ planned — see [FEATURES.md](docs/roadmap/FEATURES.md) |

Originals are never modified. Nothing is deleted. All processing runs locally in your browser.

## Install (developer mode)

```bash
npm ci
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
choose the `dist/` folder. Open https://photos.google.com and look for the **✦ Pixlixir**
chip in the bottom-right corner. Step-by-step test: [MANUAL-TEST-split.md](docs/testing/MANUAL-TEST-split.md).

## Develop

| Command | Does |
|---|---|
| `npm run build` / `npm run watch` | Build the unpacked extension into `dist/` |
| `npm test` | Unit and contract tests (Vitest) |
| `npm run typecheck` | Strict TypeScript |
| `npm run check` | All of the above |
| `npm run build:probe` | Build the live protocol probe ([tools/live-probe](tools/live-probe/probe.ts)) |

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
