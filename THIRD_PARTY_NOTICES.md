# Third-party notices

## Runtime dependencies (bundled)

| Package | License |
|---|---|
| preact | MIT |
| zod | MIT |
| idb | ISC |

## Panorama engine (bundled under `dist/pyodide/`, vendored by `scripts/vendor-pyodide.mjs`)

Shipped unmodified, pinned by version and sha256. Sources are available at the linked projects.

| Component | Version | License | Source |
|---|---|---|---|
| Pyodide (runtime, CPython 3.14 standard library) | 314.0.7 | MPL-2.0 (Pyodide); PSF-2.0 (CPython) | https://github.com/pyodide/pyodide |
| NumPy (Pyodide build) | 2.4.6 | BSD-3-Clause | https://github.com/numpy/numpy |
| opencv-python (Pyodide build of OpenCV, stitching module enabled) | 4.11.0.86 | Apache-2.0 (OpenCV); MIT (opencv-python wrapper) | https://github.com/opencv/opencv, https://github.com/pyodide/pyodide-recipes |
| — statically linked in the OpenCV wheel: FFmpeg (built without GPL components), libjpeg, libpng, zlib, libwebp, libtiff | per Pyodide recipes | LGPL-2.1-or-later (FFmpeg); IJG, libpng, zlib, BSD-3-Clause, libtiff licenses | https://github.com/pyodide/pyodide-recipes/tree/main/packages |
| Pillow (Pyodide build; writes the panorama's EXIF) | 12.2.0 | MIT-CMU (HPND) | https://github.com/python-pillow/Pillow |
| stitching (OpenStitching) | 0.7.0 | Apache-2.0 | https://github.com/OpenStitching/stitching |
| largestinteriorrectangle | 0.2.1 | Apache-2.0 | https://github.com/lukasalexanderweber/lir |

FFmpeg is LGPL: you may replace it by rebuilding the OpenCV wheel from the Pyodide recipes and
re-running the vendor step with your build.

## Development-only dependencies (not shipped)

| Package | License | Use |
|---|---|---|
| exifreader | MPL-2.0 | Tests read back the EXIF written into panoramas |

## Research references (no code copied)

- **Google-Photos-Toolkit** by xob0t — MIT — https://github.com/xob0t/Google-Photos-Toolkit.
  Used to cross-check private RPC identifiers and payload shapes. Copyright (c) 2024 xob0t.
- **google-photos-deduper** by mtalcott — AGPL-3.0-or-later — studied for integration
  strategy only. No code from this project may be incorporated into Pixlixir.
- **photo-curator** by shivarya — MIT — studied for integration strategy only.
- **imgalign** by latsic — studied as prior art for browser stitching (custom OpenCV wasm build); no code used.
- **Hugin** PTBatcherGUI "Search directory for panoramas" (grouping by camera, size and capture time)
  and graph-based automatic panorama recognition (Brown & Lowe; Zhao & Xia, CSE 2013) — design
  references for the panorama detector; no code used.
