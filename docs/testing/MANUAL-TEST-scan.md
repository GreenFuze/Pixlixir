# Manual test — Scan library for panoramas

Prereqs: `npm ci && npm run build`, reload Pixlixir in `chrome://extensions`, reload the Google
Photos tab. You need some panorama-style sequences in the library (overlapping shots taken a
few seconds apart). Test data you create can be deleted afterwards.

## Bulk operations
1. Side panel (toolbar icon, or chip → **Bulk operations**): the **Bulk operations** card holds the
   settings. It follows what is open in Photos: a selection preselects **Selected (N)**, an open
   album preselects **Album**, otherwise **Dates**.
2. **Dates**: pick From/To or a preset (30 days, 12 months, This year, Last year).
3. **Album**: choose from your albums. **Whole library** needs no more.
4. Tick **Panoramas** and/or **Wrong dates** (**Formats…** opens Settings) → **Scan**.
5. A modal opens over Google Photos and is already running: a bar with "Listing photos · N found",
   then "Checking new photos: k of n · m found · about x min left" and the engine stage; findings
   appear while it runs. **Stop** keeps what was found.
6. **–** minimizes: browse Photos while it runs; the chip shows "Scanning 34%" and brings it back
   on click. **Show** in the panel does the same, and **Scan** is off until the work ends.
   **✕** or Escape asks before stopping running work.
7. With the scan finished, **Scan** in the panel replaces the results. A date run that can still be
   undone is kept instead: close it first.

**Scan again** repeats the same scan: earlier groups appear at once and the status shows "N already
checked"; only new photos are checked. **Re-check all** in the panel ignores saved results.

## Review
9. Each group shows a preview, the photos in it and the date. Only photos that stitched are shown:
   bursts, retakes and photos that do not connect never appear. Groups Pixlixir already made show
   **Already made ↗** and are unticked. No groups at all is a valid answer for many libraries; to
   see one, photograph a scene in 3 overlapping shots while turning, then scan that date.
10. **Edit…** opens the group in Create panorama inside the modal. **← Back** or Escape returns to
    the results without saving; **Save to Google Photos** saves it, and the group then shows **Created**.

## Create in bulk
11. Tick the groups you want → **Create N** → the dialog names your account and what is
    inherited → **Create**. Each group shows its step (downloading, building, uploading).
    **Stop after this one** finishes the current panorama and stops.
12. When done: a green **N created** section lists each with a link; each group shows
    **Created**, its size and the albums it was added to. Problems (e.g. an album that could not
    be updated) are listed in red under that group.

## Check in Google Photos
13. Open a created panorama: it is a new item, dated like the earliest photo (next to them in
    the timeline), with their location (info panel map), camera details (EXIF), and the first
    photo description if any. It is in every album that holds its photos. The source photos are
    unchanged.
14. Side panel → **Recent work** lists "Panorama of N photos · from a scan".

Known limits: shared-album adds are not live-verified yet; selection scope only includes tiles
the grid reports as selected; reloading the Photos tab stops a scan, and the next one continues from saved results.
