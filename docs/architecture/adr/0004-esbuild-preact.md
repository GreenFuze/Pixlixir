# ADR-0004: esbuild + Preact, single package

**Status:** accepted (2026-11-04)

**Decision.** One npm package; esbuild bundles each MV3 entry (content script as IIFE, others
as ESM); Preact for UI; zod for message validation; idb for IndexedDB; Vitest for tests;
TypeScript 7 strict for type-checking. No extension framework (Plasmo/CRXJS/WXT).

**Why.** Minimal moving parts, fast builds, full control over the manifest and permissions.
Layering is enforced by directories (`domain` → `shared` → `imaging`/`gphotos` → `extension`),
and can be split into workspace packages when the companion arrives.
