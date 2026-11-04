# Competitive UX notes (desk research, v0.1)

Initial notes from general product knowledge; refresh with hands-on sessions before each
feature's UX is finalised. This is UX research — no code or assets are copied.

## Multi-photo scan splitting (feeds R-01…R-05)

| Product | Pattern worth learning from | Gap Pixlixir fills |
|---|---|---|
| Photomyne | Capture a whole album page; auto-detects each print, per-print crop handles, auto-rotate, optional enhancement, batch review before saving | Works on photos *already in* Google Photos, without re-capturing or a separate library |
| Google PhotoScan | Multi-shot glare removal, corner-point perspective fix | One print at a time; no splitting; no batch |
| Scanner software multi-photo modes | Auto-detects several prints on the bed | Requires the scanner workflow; not for existing scans |

Adopted: outlines + numbered order, drag corners, add missed / remove false, rotate, preview,
review-all-then-save. Deferred: per-print auto-enhance, auto-orientation (faces/text), glare fusion.

## Editing / masks (feeds S-*)

Lightroom & Photoshop: colour-coded mask overlays, add/subtract brushes, feather/flow,
generative remove with variants. Facetune: one slider per effect, hold-to-compare.
Google Photos mobile: Magic Eraser suggestions + brush, revert to original.

## Panorama / merge (feeds C-*)

PTGui / Hugin: automatic control points, projection choice, manual control-point fallback when
alignment fails. Photoshop Photomerge: one-click layout choice.

## Restoration (feeds R-06…R-10)

MyHeritage / Topaz: one-click enhance with a strength slider. Clear "AI-reconstructed"
labelling is rare — Pixlixir makes the conservative vs generative distinction explicit.
