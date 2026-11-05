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
   thumbnails (`OverlapGrouper` in `pixlixir_stitch.py`): pairs that overlap partially are
   linked, pairs that cover each other (retakes, bursts; OpenCV zeroes their confidence)
   collapse onto the earliest photo, and connected components with 2+ distinct views are
   candidates. Each candidate gets a thumbnail preview ("turning in place", falling back to
   "flat surface" only when alignment fails, and saying so).
3. *Metadata inheritance* (editor and bulk alike, `panorama-pipeline.ts`): the panorama's
   EXIF is the earliest photo's (Pillow, orientation reset, MakerNote/unique id dropped),
   with the capture time and GPS that Google Photos shows; after upload the item is dated
   like the earliest photo (`DaSgWe`), gets the first non-empty description (`AQNOFd`) and
   is added to every album holding any of its photos (`E1Cajb`; shared albums via `laUYf`).
   Google reads the EXIF GPS on upload (live-verified), so no location RPC is needed.
4. *Seeing results*: the scan page keeps a results section with links; every panorama is a
   job record (with a batch id) listed under Recent work in the side panel.

**Consequences.**
+ Future detectors reuse listing, scopes, review, bulk execution and results.
+ No new image algorithms: grouping is a time filter; overlap is the stitching library's.
+ Created items land next to their photos in the timeline and in the same albums.
− Album listings return album-specific item keys; they work with item info/details, and
  "already made" is matched by dedup key. Selection scope only sees what the Photos grid
  reports as selected (virtualised off-screen tiles may be missing).
− Shared-album adds (`laUYf`) are not live-verified yet; failures after upload are reported
  per panorama, never hidden (the panorama itself stays saved).
− Scans are not resumable yet (L-06); a whole-library scan downloads thumbnails only for
  photos in time sequences.
