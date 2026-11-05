/**
 * Capability matrix for the live web adapter. Statuses must reflect evidence in
 * docs/feasibility/google-photos-protocol.md — never upgrade without a live check.
 */

import type { Capability } from "../domain/types.js";

export const LIVE_CAPABILITIES: readonly Capability[] = [
  { id: "session.account", label: "Identify signed-in account", status: "live-verified", verifiedOn: "2026-11-04", notes: "WIZ_global_data oPEP7c (email), S06Grb (id), /u/N path." },
  { id: "selection.observe", label: "Observe selection", status: "live-verified", verifiedOn: "2026-11-04", notes: "Grid tiles: role=checkbox aria-checked next to a[href*='/photo/<mediaKey>']; viewer: /photo/<mediaKey> URL." },
  { id: "item.info", label: "Get item info", status: "live-verified", verifiedOn: "2026-11-04", notes: "VrseUb, fDcn4b (file name, size)." },
  { id: "item.details", label: "Item description, albums, location, camera", status: "live-verified", verifiedOn: "2026-11-05", notes: "fDcn4b [0][1], [0][19], [0][13]/[0][9], [0][23]." },
  { id: "item.thumbnail", label: "Thumbnails at any size", status: "live-verified", verifiedOn: "2026-11-04", notes: "baseUrl=wW-hH." },
  { id: "item.original", label: "Original photo bytes", status: "live-verified", verifiedOn: "2026-11-04", notes: "baseUrl=d with the user's cookies returns full resolution (403 without cookies); byte-identity with the uploaded original not yet proven." },
  { id: "item.original.video", label: "Original video bytes", status: "research", verifiedOn: null, notes: "Candidates: =dv suffix, VrseUb[7]." },
  { id: "library.enumerate", label: "Enumerate library", status: "live-verified", verifiedOn: "2026-11-05", notes: "lcxiM: newest first, 500/page, start at any capture time." },
  { id: "album.list", label: "List albums and album items", status: "live-verified", verifiedOn: "2026-11-05", notes: "Z5xsfc, snAcKc (album item keys differ from library keys; dedup keys match)." },
  { id: "library.upload", label: "Upload new item", status: "live-verified", verifiedOn: "2026-11-04", notes: "Resumable upload + mdpdU commit; verified with tools/live-probe (synthetic image, then trashed)." },
  { id: "item.setDate", label: "Set capture date", status: "live-verified", verifiedOn: "2026-11-04", notes: "DaSgWe (seconds); read back exactly via VrseUb in tools/live-probe." },
  { id: "item.bulkInfo", label: "Read file names and dates in bulk", status: "live-verified", verifiedOn: "2026-11-05", notes: "EWgK9e: 2,567 library items, and album item keys (read-only)." },
  { id: "item.replaceInPlace", label: "Replace content in place", status: "research", verifiedOn: null, notes: "No evidence that the web app supports this." },
  { id: "album.add", label: "Add items to an album", status: "live-verified", verifiedOn: "2026-11-05", notes: "E1Cajb for own albums (synthetic probe). Shared albums use laUYf: implemented, not live-verified." },
  { id: "item.setDescription", label: "Set description", status: "live-verified", verifiedOn: "2026-11-05", notes: "AQNOFd, read back via fDcn4b (synthetic probe)." },
  { id: "item.locationOnUpload", label: "Location of new uploads", status: "live-verified", verifiedOn: "2026-11-05", notes: "EXIF GPS in the uploaded JPEG becomes the item's location immediately." },
  { id: "item.trash", label: "Move to trash", status: "research", verifiedOn: null, notes: "XwAOJf per GPTK; intentionally not implemented in this phase." },
];
