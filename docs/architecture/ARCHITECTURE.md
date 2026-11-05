# Pixlixir — Architecture (v0.1)

## Components

```
 photos.google.com tab                       Extension (chrome-extension://…)
┌─────────────────────────────────┐         ┌──────────────────────────────────────┐
│ Content script (isolated world) │         │ Service worker (background.js)        │
│  • WizSessionReader  (tokens    │◄───────►│  • BackgroundRouter (validated msgs)  │
│    stay HERE, never exported)   │ runtime │  • TabRegistry → storage.session      │
│  • LiveWebAdapter ── batchexec  │ messages│  • opens side panel / editor tabs     │
│  • ResumableUploader            │         └──────────────────────────────────────┘
│  • SelectionObserver (DOM)      │         ┌──────────────────────────────────────┐
│  • Launcher (closed shadow DOM) │◄───────►│ Side panel (Preact)                   │
└─────────────────────────────────┘ tabs.   │ Editor tabs (Preact)                  │
          ▲                         send    │  • Split: SplitSession + split worker │
          │ same-origin fetch       Message │    (hosts the Fix panel)              │
          ▼                                 │  • Panorama: PanoramaSession + worker │
   Google Photos private web API            │    (Pyodide + OpenCV + OpenStitching) │
                                            │  • JobStore (IndexedDB)               │
                                            └──────────────────────────────────────┘
```

| Layer | Path | Depends on |
|---|---|---|
| Domain types | `src/domain` | nothing |
| Errors, codecs | `src/shared` | nothing |
| Imaging (pure TS) | `src/imaging` | shared |
| Google Photos adapter | `src/gphotos` | domain, shared |
| Extension runtime | `src/extension` | everything above |

Rules: feature code talks to `PhotosLibraryAdapter` and domain types only. RPC ids,
positional indices and DOM selectors for Google's UI exist **only** under `src/gphotos/`.

## Key decisions (ADRs)

- [ADR-0001](adr/0001-isolated-world-session.md) — Read the session from the DOM in the isolated world; no page-world injection.
- [ADR-0002](adr/0002-content-script-owns-protocol.md) — The content script is the only place that performs Google requests.
- [ADR-0003](adr/0003-classical-split-detector.md) — Classical CV in TypeScript (no OpenCV.js) for split detection.
- [ADR-0004](adr/0004-esbuild-preact.md) — esbuild + Preact, single package, no framework CLI.
- [ADR-0005](adr/0005-panorama-engine-pyodide-opencv.md) — Panorama stitching with OpenCV + OpenStitching running in Pyodide (vendored, hash-pinned).
- [ADR-0006](adr/0006-library-scan.md) — Library scan: list a scope once, run pluggable detectors, bulk actions; panorama detection; metadata inheritance.

## Boundaries & trust

| Boundary | Control |
|---|---|
| Page ↔ content script | Isolated world. We never run code in the page's JS context; we only read DOM. |
| Content script ↔ extension | `sender.id === runtime.id`, extension-page URL check, zod schema parse. Only our own pages may drive a Photos tab. |
| Account | Every request carries `expectedEmail`; the tab refuses if its signed-in email differs (`ACCOUNT_MISMATCH`). The SW resolves a tab **only** among tabs signed into that email — never "the most recent tab". |
| Secrets | `SessionContext` keeps tokens in private fields; `toJSON()` omits them; nothing logs them. |
| Media | Originals cross from the tab to the editor as base64 over extension messaging, capped at 60 MB. Processing is local. |

## Jobs & persistence

MV3 service workers die at will, so no job state lives there. The split job lives in
IndexedDB (`pixlixir/jobs`), written after every change and after every uploaded print:
reopening the editor resumes, and retries never re-upload a saved print. The tab registry
lives in `chrome.storage.session`.

## Processing engines

Today: `PrintDetector` + `PerspectiveWarper` (pure TS) in a module worker, `OffscreenCanvas`
for decode/encode. Panorama: `StitchRuntime` (Pyodide + OpenCV + OpenStitching, driven by
`pixlixir_stitch.py`) in its own module worker; the same runtime runs in Node for tests.
Editor tools are declared once in `src/extension/tools.ts` (selection rules shared by the
launcher, side panel, service worker and editors); editors share `EditorSession`,
`WorkerRpcClient/Server` and `CanvasCodec`. Fix is a separate feature behind
`FixController` (`src/extension/editor/fix/`).

Library scan: `src/scan/` holds the UI-free parts (`ScanScope`, `LibraryCatalog` paging,
`ScanDetector` contract, `LibraryScanner`, `PanoramaDetector` + `TimeSequenceGrouper`);
`src/extension/scan/` binds them to the extension (`ScanSession`, `EngineOverlapChecker`,
`PanoramaBulkCreator`, `scan.html`). Editors and the scan reach the Photos tab through
`PhotosGateway`; the panorama editor and bulk creation share `panorama-pipeline.ts`
(source loading, `MetadataInheritance`, `PanoramaPublisher`). Planned: a capability-aware `ProcessingProvider` interface
(local classical, local model via WebGPU/WASM, optional companion, cloud providers) with
explicit cost/privacy metadata shown before running.

## Optional companion (Phase 5)

Go binary via Native Messaging; hosts loopback REST/MCP for external agents with per-client
tokens, scopes, origin + Host checks (DNS rebinding), rate limits, and approval prompts routed
to the extension. The extension remains fully functional without it.

## Data model (current)

`AccountRef`, `MediaRef` (account-namespaced), `MediaItemInfo`, `CreatedMediaItem`,
`Capability`, `SplitJob` / `SplitPrintRecord` (quad, rotation, included, saved result,
error), `PanoramaJob` (sources, used sources, settings, saved result). Planned additions: `MediaVersion`, `ChangeProposal`, `MetadataSuggestion`,
`ProcessingJob` (generalising `SplitJob`).
