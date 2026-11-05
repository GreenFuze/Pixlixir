# ADR-0006: Library scan with pluggable detectors; panorama detection; metadata inheritance

**Status:** accepted (2026-11-05)

**Context.** Users want Pixlixir to *find* work across their library ("which of my photos
could be panoramas?") and do it in bulk, with an easy way to see what was created. The same
scan will later look for other things (metadata problems, duplicates, album-page scans,
HDR brackets). The user also requires that a created panorama sits "in the same place" as
its photos: same date (the first photo's), location, metadata and albums.

**Decision.**

1. *One scan, many detectors.* `LibraryScanner` lists a `ScanScope` once (date range,
   album, selection or whole library; `LibraryCatalog` over `lcxiM` / `snAcKc` / `VrseUb`)
   and hands the items to each chosen `ScanDetector`, which emits findings as it goes. The
   scan page shows findings, lets the user tick them and runs the detector's bulk action.
   New checks are new detectors; the listing, scopes, review and results UI are shared.
2. *Panorama detection* follows existing practice rather than a new algorithm: Hugin's
   "search for panoramas" groups photos by camera/size and capture time, and Brown & Lowe's
   automatic panorama recognition connects images by feature matches. Pixlixir does the
   cheap time/size grouping on listing data (≤ 30 s between shots, same pixel size, not
   already panoramic), then confirms each run with OpenStitching's SIFT matcher on 800 px
   thumbnails (`OverlapGrouper` in `pixlixir_stitch.py`). A burst also matches on its
   background, so feature matching alone is not enough; see *Telling panoramas from bursts*.
   Each candidate gets a thumbnail preview ("turning in place", else "flat surface", saying so).
   Only groups that stitch are shown, and only with the photos that stitched.
3. *Metadata inheritance* (editor and bulk alike, `panorama-pipeline.ts`): the panorama's
   EXIF is the earliest photo's (Pillow, orientation reset, MakerNote/unique id dropped),
   with the capture time and GPS that Google Photos shows; after upload the item is dated
   like the earliest photo (`DaSgWe`), gets the first non-empty description (`AQNOFd`) and
   is added to every album holding any of its photos (`E1Cajb`; shared albums via `laUYf`).
   Google reads the EXIF GPS on upload (live-verified), so no location RPC is needed.
4. *Seeing results*: the scan page keeps a results section with links; every panorama is a
   job record (with a batch id) listed under Recent work in the side panel.

5. *Modal over Google Photos*: the scan runs in an iframe of `scan.html` in a closed shadow
   root, so the user stays in their library and can minimize it to the chip (which shows
   progress). `scan.html` must be a web-accessible resource for photos.google.com; the page
   refuses to run without a one-time id that only the service worker issues. Editors still
   open in their own tab.

6. *Incremental scans*: a detector saves its result per sequence in IndexedDB (`ScanStore`,
   local only), keyed by account, detector and a signature of the photos' dedup keys plus a
   result version. Sequences are the unit because they are stable: a new photo changes only its
   own sequence, and new uploads with old dates are still found, which "scan since last date"
   would miss. Listing always runs (cheap); failed previews are not saved.
7. *Partial failure*: a sequence that cannot be checked is reported and skipped. Account and
   storage problems, or five failures in a row, stop the scan.

**Where a scan starts.** The settings live in the side panel's *Bulk operations* card, and the
modal opens already running, with a plan handed over through session storage. Results stay in the
modal: a list of previews does not fit in a panel. **Fix dates** in the panel and the launcher is
the same scan with a plan for the selected items. Running work, and a date run that can still be
undone, are brought back rather than replaced by a new plan.

**Telling panoramas from bursts.** The first version linked any confidently matching pair and
showed 394 groups on the owner's library (2,567 items, 468 time sequences), nearly all bursts of
a person moving. Measured on those sequences (2026-11-05, read-only, numbers only) and OpenCV's
public `boat`, `budapest` and `newspaper` sets, starting from `facet`'s note that a burst wobbles
in place while a sweep marches on:

| Check | Public panoramas | The owner's sequences | Limit |
|---|---|---|---|
| Aligned overlap that disagrees, per link | see note | 0.34 to 0.72 on the groups the owner flagged | 0.32 |
| Group footprint, in photos | 2.2 and up | 1.13 to 2.04 on those groups (the 2.04 fails the check above) | 1.4 |
| Stitched area, in photos | 1.72 to 2.72 | at most 1.15 on groups passing both checks above | 1.25, and at most 1.15 per photo |

Note: in the public sets, links that matter stay at or below 0.27; weak non-neighbour pairs in
wide pans can exceed the limit and simply do not count, since neighbours connect the group.
Pairs also need 25 inliers and 10% overlap; pairs covering 80% of each other are retakes. The
upper limit on stitched area is there because the turning-in-place model stretches bursts into
strips (one 2-photo burst measured 8.88 photos). With these rules **no group on the owner's
library passes**. The positive evidence is the three public sets, so the limits may be too
strict for hand-held phone panoramas; that has not been checked on such photos.

**Consequences.**
+ Future detectors reuse listing, scopes, review, bulk execution and results.
+ No new image algorithms: grouping is a time filter; overlap is the stitching library's.
+ Created items land next to their photos in the timeline and in the same albums.
− Album listings return album-specific item keys; they work with item info/details, and
  "already made" is matched by dedup key. Selection scope only sees what the Photos grid
  reports as selected (virtualised off-screen tiles may be missing).
− Shared-album adds (`laUYf`) are not live-verified yet; failures after upload are reported
  per panorama, never hidden (the panorama itself stays saved).
− A whole-library scan downloads thumbnails only for photos in time sequences, and each
  group's preview and thumbnails take local disk space (typically ~150 KB per group).
