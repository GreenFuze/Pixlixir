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
└─────────────────────────────────┘ tabs.   │ Split editor tab (Preact)             │
          ▲                         send    │  • SplitSession controller            │
          │ same-origin fetch       Message │  • JobStore (IndexedDB)               │
          ▼                                 │  • Split worker (detect/rectify/JPEG) │
   Google Photos private web API            └──────────────────────────────────────┘
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
for decode/encode. Planned: a capability-aware `ProcessingProvider` interface
(local classical, local model via WebGPU/WASM, optional companion, cloud providers) with
explicit cost/privacy metadata shown before running.

## Optional companion (Phase 5)

Go binary via Native Messaging; hosts loopback REST/MCP for external agents with per-client
tokens, scopes, origin + Host checks (DNS rebinding), rate limits, and approval prompts routed
to the extension. The extension remains fully functional without it.

## Data model (current)

`AccountRef`, `MediaRef` (account-namespaced), `MediaItemInfo`, `CreatedMediaItem`,
`Capability`, `SplitJob` / `SplitPrintRecord` (quad, rotation, included, saved result,
error). Planned additions: `MediaVersion`, `ChangeProposal`, `MetadataSuggestion`,
`ProcessingJob` (generalising `SplitJob`).
