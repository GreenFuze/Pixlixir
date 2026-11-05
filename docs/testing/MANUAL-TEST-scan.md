# Manual test — Scan library for panoramas

Prereqs: `npm ci && npm run build`, reload Pixlixir in `chrome://extensions`, reload the Google
Photos tab. You need some panorama-style sequences in the library (overlapping shots taken a
few seconds apart). Test data you create can be deleted afterwards.

## Open the scan
1. Chip (bottom-right) → **Scan library for panoramas…** (or side panel → **Scan for panoramas…**).
   With 2+ photos selected the button reads **Scan N selected for panoramas…**.
   Inside an album, the scan opens with that album preselected.
2. A new tab opens: **Scan library**, bound to your account.

## Scopes
3. **Date range**: pick From/To or a preset (Last 30 days, Last 12 months, This year, Last year).
4. **Album**: choose from your albums.
5. **Selected (N)**: only when opened with a selection.
6. **Whole library**.
7. Leave **Panoramas** ticked → **Scan**. Expect "Listing photos · N found", then
   "Checking photos taken in sequence · k of n"; groups appear while it runs. **Stop** keeps what
   was found.

## Review
8. Each group shows a preview, its photos (retakes faded), date, camera motion, and notes such as
   "2 photos did not connect" or "1 retake left out". Groups Pixlixir already made show
   **Already made ↗** and are unticked. Groups whose preview failed are unticked.
9. **Open in editor** opens the group in Create panorama (to adjust settings and save by hand).

## Create in bulk
10. Tick the groups you want → **Create N panoramas** → the dialog names your account and what is
    inherited → **Create**. Each group shows its step (downloading, building, uploading).
    **Stop after this one** finishes the current panorama and stops.
11. When done: a green **N panoramas created** section lists each with a link; each group shows
    **Created**, its size and the albums it was added to. Problems (e.g. an album that could not
    be updated) are listed in red under that group.

## Check in Google Photos
12. Open a created panorama: it is a new item, dated like the earliest photo (next to them in
    the timeline), with their location (info panel map), camera details (EXIF), and the first
    photo description if any. It is in every album that holds its photos. The source photos are
    unchanged.
13. Side panel → **Recent work** lists "Panorama of N photos · from a scan".

Known limits: shared-album adds are not live-verified yet; selection scope only includes tiles
the grid reports as selected; scans are not resumable (keep the tab open).
