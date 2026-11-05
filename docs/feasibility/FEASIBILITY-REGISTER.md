# Technical feasibility register

| Question (handoff §20/§24) | Answer so far | Evidence |
|---|---|---|
| Identify & bind the correct account? | Yes for `/u/0` (email + id from bootstrap data, checked per request). `/u/N` not yet observed. | [google-photos-protocol.md](google-photos-protocol.md) §Session |
| Retrieve media & metadata? | Yes: item info, file name, size, dimensions, capture time. | VrseUb / fDcn4b, live |
| Original bytes? | Photos: full resolution via `=d` with cookies. Byte-identity unproven. Video/HEIC/RAW untested. | §Media bytes |
| Which private operations work? | Live: info, extended info, upload + commit, set date. Seen/referenced only: library paging, albums, trash, location, description. | §RPCs |
| Browser-worker transforms? | Yes. On a real 7.5 MP phone photo of 3 prints on a patterned tablecloth (2026-11-04, Node, same code as the worker): detection ≈1.5 s, rectify ≈0.1–0.25 s and auto-fix ≈0.2–0.4 s per print. All 3 prints found and tightly outlined; the table edge was correctly rejected. | tools/dev/split-debug.ts, tests/unit/imaging.test.ts, tests/unit/enhance.test.ts |
| Single-photo glare removal? | Partial. Clipped hotspots: filled. Broad sheen: reduced with the Glare brush (veil-model inversion); heavy speckled glare on glossy paper keeps residue because the information is gone. Reliable fix needs a second shot (R-18). | tools/dev experiments on the sample |
| Panorama stitching in the browser? | Yes, with existing libraries: Pyodide's OpenCV build (stitching module) + OpenStitching in a worker, under the extension CSP (`'wasm-unsafe-eval'`). 6 × 3.4 MP (OpenCV test set): preview 2–4 s, full 10.7k × 2.7k px ≈ 9 s (Node) and end-to-end in Chromium. Flat-subject (affine) mode stitches 4 newspaper shots. Cost: +26 MB extension, 2–4 s engine start. | ADR-0005, tests/integration/panorama-engine.test.ts, editor sandbox |
| Scan the library and bulk-create panoramas? | Yes. `lcxiM` lists the timeline (500/page, from any capture time), `Z5xsfc`/`snAcKc` albums, `fDcn4b` gives description, albums, location and camera per item (all live-verified 2026-11-05, read-only). Writes verified with synthetic items (then trashed): `E1Cajb` add to album, `AQNOFd` description; EXIF GPS in an upload becomes the item's location immediately. Sandbox: 17-photo fake library → 3 groups found and created in ~2 min. | ADR-0006, tests/unit/scan.test.ts, editor sandbox |
| Native companion needed? | Not for split. Likely for video (FFmpeg), large batch jobs, local models, external API. | ARCHITECTURE.md |
| Preserve/relate versions? | Split results are new items; provenance (source key → outputs) in IndexedDB. No known way to set a derived-item link in Google Photos. | JobStore |
| Replace content in place? | Unknown; no evidence. Not attempted. | — |
| Features without private endpoints? | All processing; local download of results. | — |
