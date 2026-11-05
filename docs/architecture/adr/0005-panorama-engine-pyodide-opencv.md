# ADR-0005: Panorama stitching with OpenCV + OpenStitching, run in Pyodide

**Status:** accepted (2026-11-05)

**Context.** Panorama stitching (C-01) should be as good as Microsoft ICE: automatic
alignment, bundle adjustment, projections, exposure compensation, seam finding and
multi-band blending. That is the Brown & Lowe pipeline that ICE, PTGui, Hugin and
OpenCV's `stitching` module all implement. The project rule is to use existing,
maintained libraries before writing algorithms ourselves. Options found (2026-11-05):

| Option | Finding |
|---|---|
| Stock opencv.js (npm builds) | Does not expose the `stitching` module; community attempts to add it to the JS bindings stall on `UMat`/class wrappers. |
| Custom Emscripten build of OpenCV + our own C++ glue | Works (e.g. latsic/imgalign) but needs emsdk in our build/CI and a C++ layer to maintain. |
| AI matchers (ALIKED/SuperPoint + LightGlue via onnxruntime-web) | Better matching on hard scenes, but only matching — the rest of the pipeline is still needed; 20–50 MB models. A later add-on, not a base. |
| **Pyodide's `opencv-python` (stitching module ON) + OpenStitching** | Prebuilt, maintained by the Pyodide project, hash-pinned in `pyodide-lock.json`; OpenStitching (Apache-2.0) wraps the full OpenCV pipeline incl. an affine (flat-subject) mode. |

**Decision.** Run Pyodide 314.0.7 in a module Web Worker, load `numpy`, `opencv-python`
4.11 and OpenStitching 0.7.0 (+ `largestinteriorrectangle`), all vendored into the
extension by `scripts/vendor-pyodide.mjs` with sha256 verification (MV3 forbids remote
code). `pixlixir_stitch.py` is a thin driver: it adds a downscaled largest-interior-rectangle
search (the library's numba path runs as plain Python here and took ~20 s; now ~0.1 s),
progress reporting, an optional OpenCV (Telea) edge fill reported as made-up content,
and output sizing. Feature detector: SIFT. Extension CSP adds `'wasm-unsafe-eval'`.

**Consequences.**
+ ICE-class pipeline from mature libraries; we own ~250 lines of glue, not the algorithms.
+ Same code path runs in Node (integration tests, dev tools) and in the extension.
+ Measured: 6 × 3.4 MP photos → preview 2–4 s, full 10.5k × 2.2k px in ~9 s; flat-subject mode works on overlapping document shots.
− Extension grows by ~26 MB (Pyodide runtime 12 MB + OpenCV 10.7 MB + numpy 3 MB).
− First use per editor tab pays ~2–4 s to start the interpreter.
− wasm32 memory limits the output: saves are capped (60 MP max setting) and very large selections are downscaled with a visible notice.
− Edge fill is classical inpainting (good for sky/water, smeared on detail); generative fill belongs to the AI Studio providers later.
− The OpenCV wheel statically links FFmpeg (LGPL-2.1+, built without GPL parts) and other libraries; see THIRD_PARTY_NOTICES.md.
