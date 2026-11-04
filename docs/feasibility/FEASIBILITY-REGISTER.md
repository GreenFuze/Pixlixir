# Technical feasibility register

| Question (handoff §20/§24) | Answer so far | Evidence |
|---|---|---|
| Identify & bind the correct account? | Yes for `/u/0` (email + id from bootstrap data, checked per request). `/u/N` not yet observed. | [google-photos-protocol.md](google-photos-protocol.md) §Session |
| Retrieve media & metadata? | Yes: item info, file name, size, dimensions, capture time. | VrseUb / fDcn4b, live |
| Original bytes? | Photos: full resolution via `=d` with cookies. Byte-identity unproven. Video/HEIC/RAW untested. | §Media bytes |
| Which private operations work? | Live: info, extended info, upload + commit, set date. Seen/referenced only: library paging, albums, trash, location, description. | §RPCs |
| Browser-worker transforms? | Split detection + rectification + JPEG encode in a worker: yes (unit-tested). Performance on real 12–50 MP scans still to be measured. | tests/unit/imaging.test.ts |
| Native companion needed? | Not for split. Likely for video (FFmpeg), large batch jobs, local models, external API. | ARCHITECTURE.md |
| Preserve/relate versions? | Split results are new items; provenance (source key → outputs) in IndexedDB. No known way to set a derived-item link in Google Photos. | JobStore |
| Replace content in place? | Unknown; no evidence. Not attempted. | — |
| Features without private endpoints? | All processing; local download of results. | — |
