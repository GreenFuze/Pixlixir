# Pixlixir — Master Feature List

The single source of truth for *everything* Pixlixir intends to do. Every feature from the
original product handoff is listed here with an ID, target phase, and an honest status.

**Status legend**

| Status | Meaning |
|---|---|
| `todo` | Not started |
| `research` | Feasibility unknown; needs an experiment before design |
| `wip` | Being implemented |
| `implemented` | Built and unit-tested; end-to-end run on a real account still pending |
| `mock-only` | Works against the mock adapter only — **not** verified on live Google Photos |
| `live-verified` | Verified end-to-end on a real Google Photos account (date + evidence in `docs/feasibility/`) |
| `blocked` | Technically or policy-blocked; see linked evidence |
| `deferred` | Intentionally postponed (non-goal for now) |

Phases follow [ROADMAP.md](ROADMAP.md). `P1` = must-have for that phase.

---

## F — Foundation & platform

| ID | Feature | Phase | Status |
|---|---|---|---|
| F-01 | MV3 extension skeleton (service worker, content script, side panel, editor tab) | 1 | implemented |
| F-02 | Detect Google Photos tabs (incl. `/u/N/` multi-login paths) | 1 | implemented |
| F-03 | Explicit account binding: show account in panel, pin jobs to an account, refuse cross-account ops | 1 | implemented |
| F-04 | Selection tracking (grid checkboxes, single-photo viewer, album context) | 1 | implemented |
| F-05 | Contextual entry point injected into Google Photos (compact button / menu) | 1 | implemented |
| F-06 | Side panel: account, selection, contextual actions, jobs, review queue, settings | 1 | implemented |
| F-07 | Persistent job framework (IndexedDB, survives SW restarts, progress, cancel, retry) | 1 | implemented |
| F-08 | Capability matrix reporting (per-capability status + confidence) | 1 | implemented |
| F-09 | Mockable Google Photos adapter interface + mock implementation | 1 | implemented |
| F-10 | Settings (providers, privacy defaults, theme) | 1 | todo |
| F-11 | Message validation (sender checks, typed schemas) | 1 | implemented |
| F-12 | Light/dark theme, keyboard shortcuts, a11y labels | 1 | wip |
| F-13 | i18n scaffolding (English first; Hebrew/RTL ready) | 2 | todo |
| F-14 | Local metadata/provenance store (derived ↔ original links) | 2 | implemented |
| F-15 | Reusable review/commit UI (preview → approve → apply → audit) | 3 | todo |
| F-16 | Audit trail of all library mutations | 3 | todo |
| F-17 | CI (typecheck, lint, unit, build) | 1 | implemented |
| F-18 | Browser E2E harness (Playwright + unpacked extension, mock Photos page) | 2 | todo |

## G — Google Photos integration (adapter)

| ID | Capability | Phase | Status |
|---|---|---|---|
| G-01 | Read session context (account email/id, `/u/N`, tokens) without exporting secrets | 1 | live-verified |
| G-02 | Enumerate library (paged timeline) | 2 | research |
| G-03 | Get item info (dimensions, timestamp, filename, size, type) | 2 | live-verified |
| G-04 | Thumbnails at arbitrary size | 1 | live-verified |
| G-05 | Original-quality bytes (photos) | 2 | live-verified |
| G-06 | Original bytes for video / HEIC / RAW | 2 | research |
| G-07 | List albums / album items | 2 | research |
| G-08 | Upload new media item | 3 | live-verified |
| G-09 | Create album / add to album | 3 | research |
| G-10 | Set date/time | 4 | live-verified |
| G-11 | Set location | 4 | research |
| G-12 | Set description | 4 | research |
| G-13 | Trash / restore from trash | 4 | research |
| G-14 | Replace image content in place (no new item) | 4 | research |
| G-15 | Shared albums / partner sharing coverage | 4 | research |
| G-16 | Locked Folder interaction | 6 | research |
| G-17 | Contract tests with sanitized fixtures; fail-safe on unknown shapes | 2 | todo |

## S — AI Photo Studio

| ID | Feature | Phase | Status |
|---|---|---|---|
| S-01 | Editor workspace (large canvas, zoom/pan, before/after) | 3 | todo |
| S-02 | Text-instruction editing | 3 | todo |
| S-03 | Iterative revisions + history (original → rev N), revert | 3 | todo |
| S-04 | Brush modes: Remove / Add / Replace / Protect / Retouch (color-coded masks) | 3 | todo |
| S-05 | Brush controls: size, hardness/feather, opacity, eraser, add/subtract, undo/redo, mask visibility | 3 | todo |
| S-06 | Combined brush + text instructions | 3 | todo |
| S-07 | Capability-aware provider interface (orchestrator vs editor vs both) | 3 | todo |
| S-08 | Providers: OpenAI images, Gemini image editing, local inpainting, OpenCV classical | 3 | todo |
| S-09 | Pre-flight disclosure: cost, local/cloud, privacy | 3 | todo |
| S-10 | Save as new / download / replace (only if G-14 verified) | 3 | todo |
| S-11 | Smart selections: people, faces, skin, teeth, eyes, hair, clothing, fg/bg, objects (editable) | 4 | todo |
| S-12 | Portrait: skin smoothing, blemish removal, teeth whitening, eye enhance | 4 | todo |
| S-13 | Portrait: face/body reshape, slimming (explicit intensity, never silent) | 4 | todo |
| S-14 | Portrait: shadow reduction, portrait lighting, background blur, hair | 4 | todo |
| S-15 | Classic adjustments: exposure, contrast, WB, saturation, color balance, sharpness, NR | 4 | todo |
| S-16 | Geometry: crop, rotate, perspective, vignette, selective color, tone curve | 4 | todo |
| S-17 | Provenance record per revision (provider, model, params, parent) | 3 | todo |

## V — Video Studio

| ID | Feature | Phase | Status |
|---|---|---|---|
| V-01 | Trim, crop, rotate, perspective | 5 | todo |
| V-02 | Stabilization | 5 | todo |
| V-03 | Auto light/color, denoise, sharpen, upscale, restoration | 5 | todo |
| V-04 | Background removal/replacement, object removal | 6 | todo |
| V-05 | Audio: noise reduction, wind removal, normalization | 5 | todo |
| V-06 | Auto subtitles | 6 | todo |
| V-07 | Frame extraction, representative-frame selection | 5 | todo |
| V-08 | Speed / slow-motion, timelapse, join clips | 5 | todo |
| V-09 | Video metadata correction | 5 | todo |
| V-10 | Progress + cancellation for heavy jobs | 5 | todo |

## C — Combine & Compose

| ID | Feature | Phase | Status |
|---|---|---|---|
| C-01 | Panorama: overlap analysis, arrangement, align, projection, exposure, seam blend, crop, save | 4 | todo |
| C-02 | Panorama manual correction (control points) | 4 | todo |
| C-03 | Cylindrical / spherical 360° panoramas | 6 | todo |
| C-04 | HDR merge (align + natural/aggressive tone mapping) | 4 | todo |
| C-05 | Focus stacking | 4 | todo |
| C-06 | Best-shot group composition (marked as composite) | 6 | todo |
| C-07 | Multi-image super-resolution | 6 | research |
| C-08 | Long-exposure simulation; tourist removal | 6 | research |
| C-09 | Combine overlapping scans | 6 | research |
| C-10 | Collages / simple composites | 6 | research |
| C-11 | Multi-capture reflection removal | 6 | research |

## R — Restore & Digitize

| ID | Feature | Phase | Status |
|---|---|---|---|
| R-01 | **Split scan into photos**: detect prints, outline, rotation/perspective aware | 3 | implemented |
| R-02 | Split: adjust boundaries, add missed, remove false detections | 3 | implemented |
| R-03 | Split: crop/straighten/perspective-correct each print | 3 | implemented |
| R-04 | Split: save each as a new item; original untouched; provenance recorded | 3 | implemented |
| R-05 | Split: optional per-print enhancement | 4 | todo |
| R-06 | Damage repair — conservative (tears, cracks, folds, scratches, dust, stains) | 3 | todo |
| R-07 | Damage repair — generative reconstruction (flagged as invented detail) | 4 | todo |
| R-08 | Manual damage painting + editable auto-detected damage mask | 3 | todo |
| R-09 | Color restoration: fade, WB, contrast, cast removal, yellowing (with "preserve character" option) | 4 | todo |
| R-10 | Colorize B&W | 4 | todo |
| R-11 | Scan improvements: deskew, uneven lighting, glare, reflections, curvature, moiré, dust | 4 | todo |
| R-12 | Multi-exposure scan fusion | 6 | research |
| R-13 | Negatives (incl. orange mask) and slides | 6 | todo |
| R-14 | Front/back pairing + OCR/handwriting extraction (never auto-verified) | 4 | todo |
| R-15 | Fragment reassembly of torn photos | 6 | research |
| R-16 | Find a cleaner copy in library before generative fill | 6 | research |
| R-17 | Batch digitization overview (detections, failures, quality warnings, review before save) | 4 | todo |

## D — Smart Cleanup

| ID | Feature | Phase | Status |
|---|---|---|---|
| D-01 | Exact duplicates (content hash on original bytes only) | 3 | todo |
| D-02 | Near-duplicates (perceptual hash, embeddings, metadata) — never labeled identical | 3 | todo |
| D-03 | Staged pipeline: candidates → light check → detailed → full-res verify | 3 | todo |
| D-04 | Best-copy recommendation with explanation | 3 | todo |
| D-05 | Library hygiene: blurry, bad exposure, screenshots, repeated downloads, large videos, bursts | 4 | todo |
| D-06 | Cross-account duplicate detection (authorized accounts only) | 6 | research |
| D-07 | Storage-savings estimate (labeled estimate unless verified) | 4 | todo |
| D-08 | Safe bulk ops: preview, edit keep-set, exclude groups, batches, pause/resume, results | 4 | todo |

## M — Metadata Repair

| ID | Feature | Phase | Status |
|---|---|---|---|
| M-01 | Detect wrong dates/times, TZ errors, camera clock offset, missing timestamps | 4 | todo |
| M-02 | Bulk time shift with preview ("this camera is +3h") | 4 | todo |
| M-03 | Geolocation inference (neighbors in time, trips, landmarks, GPX) with confidence + evidence | 4 | todo |
| M-04 | Interactive map: approve/reject/move pin/apply to many/mark unknown | 4 | todo |
| M-05 | Metadata layers: Google vs embedded EXIF/XMP vs inferred vs user vs local annotations | 4 | todo |
| M-06 | Orientation fixes; camera metadata inconsistencies | 4 | todo |
| M-07 | Batch description updates; preserve handwritten annotations | 4 | todo |
| M-08 | Export corrected metadata with derived media | 4 | todo |

## X — Private Vault

| ID | Feature | Phase | Status |
|---|---|---|---|
| X-01 | Threat model + security design review (gate before any code) | 6 | todo |
| X-02 | Locked Folder helper (only if legitimately accessible) | 6 | research |
| X-03 | Client-side encrypted vault (AEAD + reviewed KDF), separate unlock | 6 | todo |
| X-04 | Private gallery/viewer, auto-lock, wipe decrypted material on lock | 6 | todo |
| X-05 | Provider-independent encrypted storage interface | 6 | research |
| X-06 | Encrypted backup + recovery | 6 | todo |

## P — Mobile-feature parity research

| ID | Feature | Phase | Status |
|---|---|---|---|
| P-01 | Research matrix: Magic Eraser, generative edit, Unblur, Best Take, Auto Frame, portrait, stabilization, video editor | 0 | research |
| P-02 | Independent equivalents for features not legitimately accessible | 6 | todo |

## A — External AI & app integration (cross-cutting)

| ID | Feature | Phase | Status |
|---|---|---|---|
| A-01 | Optional Go companion (native messaging) | 5 | todo |
| A-02 | Localhost REST + MCP gateway (loopback, per-client auth, DNS-rebinding protection, rate limits) | 5 | todo |
| A-03 | Read ops: list/search/get/download photo, metadata, similar, duplicates, albums | 5 | todo |
| A-04 | Edit ops: edit/restore/split/panorama/video/propose_metadata_fix | 5 | todo |
| A-05 | Mutation ops via approval: save, album ops, update metadata, cleanup proposals | 5 | todo |
| A-06 | Scoped permissions per client (read/search/download/process/upload/modify/organize/trash) | 5 | todo |
| A-07 | Job IDs, status, progress, structured errors for agents | 5 | todo |
| A-08 | Vault ops behind separate consent model; keys never exposed | 6 | todo |

## Q — Quality & safety (cross-cutting)

| ID | Item | Phase | Status |
|---|---|---|---|
| Q-01 | Unit tests for image-processing logic with synthetic fixtures | 1+ | wip |
| Q-02 | Protocol parser contract tests | 2 | todo |
| Q-03 | Extension messaging + account-binding tests | 1 | implemented |
| Q-04 | Job persistence/recovery tests | 1 | implemented |
| Q-05 | Security tests: message senders, permissions, no credential leakage | 2 | todo |
| Q-06 | Synthetic fixture set: overlapping/tilted prints, torn, scratches, faded, panorama, dupes, corrupt | 3 | wip |
| Q-07 | Policy/ToS risk register kept current | 0 | wip |
