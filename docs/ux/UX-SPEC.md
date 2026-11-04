# Pixlixir — UX specification (v0.1)

Three surfaces, used in this order of preference:

1. **In-page launcher** — a small "✦ Pixlixir" chip in Google Photos (bottom-right). Click →
   contextual menu for the current selection. Never adds buttons to Google's own toolbar.
2. **Side panel** — command center: account, selection, actions, recent work, capability status.
3. **Workspace tab** — a full extension tab for anything that needs a big canvas (split,
   restore, studio, review).

## Contextual actions

| Selection | Actions (✓ = available now) |
|---|---|
| One photo | ✓ Split into Photos · Restore · Edit with AI · Retouch · Find similar · Fix metadata |
| Several photos | Create panorama · Merge HDR · Focus stack · Best shot · Find duplicates · Batch edit |
| A video | Fix video · Enhance · Extract frame · Edit audio |
| Nothing | Open panel |

Unavailable actions are shown as "planned" in the panel, never as working buttons.

## Wireframes

### Launcher (in Google Photos)

```
                                        ┌──────────────────────────┐
                                        │ Split into Photos        │
                                        │ Open Pixlixir panel      │
                                        │ Select or open one       │
                                        │ scanned photo to split…  │
                                        └──────────────────────────┘
                                                  ( ✦ Pixlixir  1 )
```

### Side panel

```
┌ ✦ Pixlixir ─────────────────────┐
│ ACCOUNT                         │
│ someone@gmail.com · /u/0        │
├─────────────────────────────────┤
│ SELECTION                       │
│ 1 item selected                 │
│ [ Split into Photos ]           │
│ ▸ Planned actions               │
├─────────────────────────────────┤
│ RECENT WORK                     │
│ Split album-03.jpg  3/3 saved ✓ │
├─────────────────────────────────┤
│ ▸ What works today              │
└─────────────────────────────────┘
```

### Split into Photos (workspace tab)

```
┌ ✦ Split into Photos  album-03.jpg ─────────── Account: someone@gmail.com ┐
│ ┌──────────────────────────────────────────┐ ┌ 3 photos found [+ Add] ┐  │
│ │   ┌───1───┐        ┌────2────┐           │ │ [thumb] Photo 1        │  │
│ │   │       │        │         │           │ │  ⟲ ⟳ ☑Include ✕        │  │
│ │   └───────┘        │         │           │ │ [thumb] Photo 2  Check │  │
│ │        ┌─────3─────┴─┐       │           │ │  edges ⟲ ⟳ ☑ ✕         │  │
│ │        │             │───────┘           │ │ [thumb] Photo 3 Saved ✓│  │
│ │        └─────────────┘   (drag corners)  │ │  Open in Google Photos │  │
│ └──────────────────────────────────────────┘ └────────────────────────┘  │
│ ☑ Use the scan's date   The original is never changed  [Download] [Save 2] │
└──────────────────────────────────────────────────────────────────────────┘
```

Interaction rules:

- Detected outlines are colour-coded and numbered in reading order.
- Click an outline or card to select it; drag corners to reshape, drag inside to move;
  `Delete` removes it; "+ Add photo" adds a rectangle for missed prints.
- Low-confidence detections show a "Check edges" badge.
- Rotate buttons fix sideways prints; previews update live.
- Save opens a confirmation naming the account and stating that items are added as new.
- Progress shows `Saving n/N`; each card switches to "Saved ✓ · Open in Google Photos".
- Failed items keep their error and can be retried; already-saved items are never re-uploaded.
- Re-opening the same scan resumes the unfinished job.

### Planned surfaces (to be designed in their phase)

- **Studio / Restore**: large canvas, brush modes (Remove red, Add green, Replace blue,
  Protect yellow, Retouch purple), size/hardness/opacity, undo/redo, zoom/pan, before/after
  slider, revision rail, prompt box, provider selector with cost/privacy badge.
- **Review**: one reusable review grid for duplicates, metadata changes, batch edits — groups,
  proposed action per item, keep/skip toggles, bounded "Apply N changes" with confirmation.
- **Metadata map**: map with suggested pins (confidence colour), evidence list, approve /
  reject / move / apply-to-selection / mark unknown.

## Accessibility & i18n

Keyboard reachable controls, visible focus, ARIA labels on icon buttons, live regions for
progress, light/dark via `prefers-color-scheme`, logical CSS properties for future RTL (Hebrew).
