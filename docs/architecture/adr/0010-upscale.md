# ADR-0010: Upscale on this computer, with Real-ESRGAN's compact model

**Status:** accepted, 2026-11-09. Measured on synthetic pictures and on one GPU only; no real photo has
been judged yet.

## Context

The owner wants a photo, especially a grainy one, enlarged so it holds up when zoomed. Google Photos
on the web has no upscaling. On the phone it has Zoom Enhance, only on Pixel 9 Pro (and reportedly
8 Pro) phones, so this brings a phone-only feature to the web (product scope rule).

Upscaling draws in plausible detail; it does not recover what the camera missed. It helps small and
soft pictures most: old phone photos, copies sent through messaging apps, scanned prints. A sharp
12 MP photo gains little.

## Decision

1. **Model.** Real-ESRGAN's compact general models, `realesr-general-x4v3` and
   `realesr-general-wdn-x4v3` (BSD-3-Clause, release v0.2.5.0, hashes in `src/extension/models/README.md`).
   They are made for real-world photos with noise and compression, and are small (1.2 M weights each).
   Heavier models (RRDB Real-ESRGAN, SwinIR) were not chosen: tens of times slower in a browser.
   Face restorers (GFPGAN, CodeFormer) are left out: their licenses restrict use.
2. **Grain.** Real-ESRGAN blends the two models weight by weight with a "denoise strength". Both sets
   are put in one ONNX file with that strength as a second input (`tools/models/export_realesrgan.py`),
   so the **Smooth** slider changes it without loading another model: left keeps grain and noise,
   right smooths them away. Weights are stored as float16 (4.9 MB); the result differs from the
   original weights by at most 0.52 of 255.
3. **Runtime.** ONNX Runtime Web 1.31.1 (MIT), in a worker, on the GPU through WebGPU or on the CPU.
   The device is shown and chosen by the user; nothing switches by itself. One WebAssembly thread:
   extension pages are not cross-origin isolated. The model and runtime ship inside the extension;
   nothing is fetched, and no picture leaves the computer.
4. **Tiles.** The photo is cut into 192 px tiles, each read with a 16 px margin that is cut away
   after (the model sees 34 px each way; Real-ESRGAN itself uses 10). 2x is the 4x result averaged
   over 2 x 2 pixels, as Real-ESRGAN's own `outscale` does. Results above 50 megapixels are refused
   (canvas limits, and the 45 MB upload limit).
5. **Where.** A panel in Edit, so the result is a version like any other: Compare, Undo, Download,
   Save as new with the original's details, and the edit record. The **Upscale** tool opens Edit with
   the panel. The panel previews a 128 px area at 4x, before and after, where the user clicks.

## Measured (2026-11-09)

- **Quality**, synthetic 256 px scene of stripes, a disc and an edge, shrunk 4x and enlarged back
  (unit test): edge sharpness 10.3 against 11.5 in the original and 6.6 for bilinear; PSNR slightly
  better than bilinear (perceptual models do not aim at PSNR; +0.24 dB). Synthetic grain: more kept at
  Smooth 0 than at 1 (test asserts 1.5 times the spread).
- **Speed**, headless Chromium, RTX 3070 Laptop, WebGPU: 400 x 300 to 4x in 0.34 s; 1600 x 1200
  to 4x or 2x in 3.7 s; 4000 x 3000 to 2x (8000 x 6000) in 23 s. A preview takes about 30 ms after
  the first (0.46 s). CPU: 400 x 300 to 4x in 9.5 s, about 80 s per source megapixel, so a 12 MP photo
  would take about a quarter of an hour.

## Consequences

+ No account, key or upload; works offline once installed.
+ The grain choice is the user's, previewed before the whole photo is done.
− The extension grows by about 34 MB unpacked (28.7 MB runtime, 4.9 MB model).
− Speed on other GPUs, integrated graphics and Macs is not measured. WebGPU may be missing; CPU is
  then the only choice and is slow on large photos.
− Model detail is invented. Faces and text can come out wrong; nothing checks for it.
− One photo at a time. Batch upscaling is not built.
