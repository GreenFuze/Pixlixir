/**
 * Capability matrix for the live web adapter. Statuses must reflect evidence in
 * docs/feasibility/google-photos-protocol.md — never upgrade without a live check.
 */

import type { Capability } from "../domain/types.js";

export const LIVE_CAPABILITIES: readonly Capability[] = [
  { id: "session.account", label: "Identify signed-in account", status: "live-verified", verifiedOn: "2026-11-04", notes: "WIZ_global_data oPEP7c (email), S06Grb (id), /u/N path." },
  { id: "selection.observe", label: "Observe selection", status: "live-verified", verifiedOn: "2026-11-04", notes: "Grid tiles: role=checkbox aria-checked next to a[href*='/photo/<mediaKey>']; viewer: /photo/<mediaKey> URL." },
  { id: "item.info", label: "Get item info", status: "live-verified", verifiedOn: "2026-11-04", notes: "VrseUb, fDcn4b (file name, size)." },
  { id: "item.thumbnail", label: "Thumbnails at any size", status: "live-verified", verifiedOn: "2026-11-04", notes: "baseUrl=wW-hH." },
  { id: "item.original", label: "Original photo bytes", status: "live-verified", verifiedOn: "2026-11-04", notes: "baseUrl=d with the user's cookies returns full resolution (403 without cookies); byte-identity with the uploaded original not yet proven." },
  { id: "item.original.video", label: "Original video bytes", status: "research", verifiedOn: null, notes: "Candidates: =dv suffix, VrseUb[7]." },
  { id: "library.enumerate", label: "Enumerate library", status: "research", verifiedOn: null, notes: "lcxiM paging seen in live traffic; adapter not implemented yet." },
  { id: "library.upload", label: "Upload new item", status: "live-verified", verifiedOn: "2026-11-04", notes: "Resumable upload + mdpdU commit; verified with tools/live-probe (synthetic image, then trashed)." },
  { id: "item.setDate", label: "Set capture date", status: "live-verified", verifiedOn: "2026-11-04", notes: "DaSgWe (seconds); read back exactly via VrseUb in tools/live-probe." },
  { id: "item.replaceInPlace", label: "Replace content in place", status: "research", verifiedOn: null, notes: "No evidence that the web app supports this." },
  { id: "album.create", label: "Create album / add items", status: "research", verifiedOn: null, notes: "OXvT9d / E1Cajb per GPTK; not implemented." },
  { id: "item.trash", label: "Move to trash", status: "research", verifiedOn: null, notes: "XwAOJf per GPTK; intentionally not implemented in this phase." },
];
