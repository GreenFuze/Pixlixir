# Pixlixir — Product Requirements (v0.1)

> Pixlixir makes the Google Photos you already use more powerful. It does not replace it.

## Problem

Fixing an old scan, splitting an album page, removing an object or repairing metadata
today means: find the photo → download → open another app → edit → export → upload →
re-organise. Google Photos' desktop web app lacks many of these tools; some exist only on
mobile.

## Product principles

1. **Google Photos stays the primary interface.** No new gallery. We add contextual actions,
   a side panel and a focused editor tab.
2. **Select → choose → review → save.** Pixlixir handles every intermediate step.
3. **Originals are sacred.** Results are saved as new items; the source is never modified.
4. **Local-first, privacy-conscious.** Processing runs in the browser by default; any cloud
   processing is explicit and per-operation.
5. **Honest capabilities.** Every feature is labelled verified / unverified / research / blocked.
   We never report success unless Google Photos actually changed.
6. **Explicit accounts.** Every write is bound to a named Google account and re-checked
   before execution.

## Users & top jobs

| User | Job |
|---|---|
| Family archivist digitising albums | Photograph an album page, split it into separate dated photos |
| Anyone with old prints in their library | Repair creases, scratches, fading; keep the original |
| Everyday user | Remove an object, fix lighting, retouch a portrait from desktop |
| Library tidier | Find duplicates, fix wrong dates and missing locations safely |
| Power user / agent builder | Let an AI agent work on authorised photos via a controlled API |

## Product areas

AI Photo & Video Studio · Combine & Compose · Restore & Digitize · Smart Cleanup ·
Metadata Repair · Private Vault — plus External AI integration (cross-cutting) and a
mobile-parity research track. The full, ID'd list is in
[docs/roadmap/FEATURES.md](../roadmap/FEATURES.md).

## Prioritisation

Flagships for the first useful release (Phase 3):

1. **Split into Photos** (R-01…R-04) — *delivered first*: highest pain, fully local, needs only
   read + upload, both now live-verified.
2. **Conservative restoration** with brush masks (R-06, R-08).
3. **Basic Studio**: text + remove/add masks, provider selection, save as new (S-01…S-10).
4. **Duplicate discovery**, read-only (D-01…D-04).

Why split first: it is a complete vertical slice (contextual entry → editor → review → save
→ verify) that exercises every layer the later features reuse — account binding, original
download, workers, review UI, upload, provenance and job persistence.

## Non-goals (for now)

Replacement gallery · Drive-based storage · backup service · Android app · mandatory backend ·
mandatory desktop app for basic editing · the official restricted Photos Library API ·
Photoshop clone · full video timeline editor · AI-generated albums · destructive automated
cleanup · mandatory cloud AI upload · a "vault" that only hides files · an unrestricted
account-control endpoint.

## Success criteria (MVP, from the handoff §21)

Scenarios A–G. Status for this release:

| Scenario | Status |
|---|---|
| A — install, panel, detect account, contextual action, no companion | implemented; awaiting your manual run |
| B — split an old scan, save, verify, original preserved | implemented; protocol pieces live-verified; awaiting your manual run |
| C — damaged-photo repair | not started (Phase 3) |
| D — brush + text edit | not started (Phase 3) |
| E — duplicates | not started (Phase 3) |
| F — error handling on protocol change | implemented for the split path (typed shape checks, no guessed retries) |
| G — account safety | implemented (bound email checked in the tab before every read/write) |
