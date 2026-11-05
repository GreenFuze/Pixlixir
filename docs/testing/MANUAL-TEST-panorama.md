# Manual test — Create panorama

Prereqs: `npm ci && npm run build` (the build vendors the panorama engine into `dist/pyodide/`,
~26 MB, downloading pinned files once). Chrome → `chrome://extensions` → reload Pixlixir (or
**Load unpacked** → `dist/`). Reload the Google Photos tab.

You need 2–40 overlapping photos in your library, e.g. a landscape shot turning in place
(roughly ⅓ overlap between neighbours), or a poster/document photographed in parts.

1. In the Google Photos grid, tick the photos (hover → checkmark). The chip badge shows the count.
2. Chip → **Panorama** icon (or the same icon in the side panel). A new tab opens bound to your account.
3. Expect "Downloading photo N of M…", then a preview within a few seconds (first use starts the engine: +2–4 s).
4. The photo list marks each photo **In panorama**, **Not connected** (no overlap found) or **Left out**.
5. Try the settings; the preview updates after each change:
   - **Turning in place** vs **Moving over a flat surface** (use the latter for documents / posters / album pages).
   - **Projection** (Spherical, Cylindrical, Perspective, Panini, …) and **Straighten horizon**.
   - **Edges**: *Crop to rectangle* vs *Fill edges* — fill shows the made-up share (%) and a magenta overlay you can hide.
   - **Try harder to connect photos** when a photo shows "Not connected".
   - Untick a photo's **Include** to leave it out.
6. **Saved size** shows the expected pixel size (full resolution unless above the cap).
7. **Download** saves the full panorama locally (no library change).
8. **Save to Google Photos** → the dialog names your account and the size → Save. Expect
   "Building the full-size panorama…" → "Uploading…" → **Saved to Google Photos** + "Open in Google Photos ↗".
9. Open it: it is a new item, full size, dated like the earliest photo (if that option was on). The source photos are unchanged.
10. Side panel → **Recent work** lists "Panorama of N photos" with a link.

Known limits: no manual control points yet (C-02); very wide 360° wrap-around is untested;
edge fill is classical inpainting (smears detail); videos and HEIC files Chrome cannot decode
are rejected with a clear message; uploads over ~45 MB are refused (choose a smaller size).

Clean-up: the saved panorama is a normal item; delete it in Google Photos if it was test data.
