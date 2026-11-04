# ADR-0003: Classical CV in TypeScript for print detection

**Status:** accepted (2026-11-04)

**Context.** Split-into-Photos needs print detection, minimum-area rectangles and perspective
rectification. OpenCV.js would provide these but adds ~8–10 MB WASM and a heavy dependency.

**Decision.** Implement a small pipeline in TypeScript: border-median background model,
colour-distance + Sobel-edge foreground, morphology, hole filling, connected components,
convex hull, rotating-calipers min-area rectangle, DLT homography, bilinear warp. Runs in a
module worker on a ≤900 px analysis copy; rectification uses full resolution.

**Consequences.** + Tiny bundle, fully unit-tested with synthetic scans, no WASM build.
+ The min-area rectangle encloses every foreground pixel, so prints are never silently cut.
− Touching/overlapping prints may merge; uniform prints matching the background with no edge
may be missed — mitigated by manual add/adjust. A learned detector can be added behind the
same `DetectedPrint` contract later.
