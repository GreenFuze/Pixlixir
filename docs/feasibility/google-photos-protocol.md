# Google Photos web protocol — feasibility evidence

Everything here is **undocumented, unsupported, and may change without notice**. It is
research evidence, not a promise. All code that depends on it lives in `src/gphotos/`.

- **Observed on:** 2026-11-04, Chrome, photos.google.com, a personal account (`/u/0`).
- **Method:** read-only inspection of page globals and network traffic in the signed-in tab;
  two synthetic upload probes (generated images, then moved to Trash); the reproducible
  probe in [`tools/live-probe/probe.ts`](../../tools/live-probe/probe.ts).
- **Cross-checked against:** xob0t/Google-Photos-Toolkit v3.3.0 (MIT) source. No code was copied.
- **Never recorded:** tokens, cookies, personal media, or real media keys. Fixtures in
  `tests/` are synthetic.

## Session

| Item | Finding | Status |
|---|---|---|
| Bootstrap data | Inline `<script>` sets `window.WIZ_global_data = {…}`; the object literal is valid JSON, so an **isolated-world content script can parse it from the DOM** without injecting code into the page. | live-verified |
| Account email | `oPEP7c` | live-verified |
| Account id | `S06Grb` (numeric string) | live-verified |
| XSRF token | `SNlM0e` → form field `at` | live-verified |
| Session id / build | `FdrFJe` → `f.sid`, `cfb2h` → `bl` | live-verified |
| Path prefix | `eptZe` = `/_/PhotosUi/` on `/u/0` (expected `/u/N/_/PhotosUi/` for other logins — **not yet observed**) | partial |

## batchexecute transport

`POST https://photos.google.com{eptZe}data/batchexecute?rpcids=<id>&source-path=<path>&f.sid=…&bl=…&hl=en&_reqid=<n>&rt=c`
Body: `f.req=<urlenc JSON [[[rpcId, JSON(payload), null, "generic"]]]>&at=<xsrf>&` with
`content-type: application/x-www-form-urlencoded;charset=UTF-8`, cookies included.

Response: `)]}'` prefix, then length-prefixed chunks; the payload line contains
`["wrb.fr", rpcId, "<json string>", …]`. A `null` payload means the call was rejected.

Live-verified on 2026-11-04 from page context: `VrseUb`, `fDcn4b`, `mdpdU`, `DaSgWe`.

## RPCs used by Pixlixir today

| RPC | Purpose | Request | Response fields used | Status |
|---|---|---|---|---|
| `VrseUb` | Item info | `[mediaKey, null, null, null, null]` | `[0][0]` mediaKey, `[0][1][0]` base URL, `[0][1][1..2]` w/h, `[0][2]` taken ms, `[0][3]` dedupKey, `[0][4]` tz ms | live-verified |
| `fDcn4b` | Extended info (own items only) | `[mediaKey, 1, null, null, 1]` | `[0][2]` file name, `[0][5]` size bytes | live-verified |
| `mdpdU` | Commit an upload | `[[[uploadToken, fileName, clientTimeMs, 2, 2]]]` | `[0][0][1]` = new item: `[0]` mediaKey, `[1][1..2]` w/h, `[3]` dedupKey | live-verified |
| `DaSgWe` | Set capture time | `[[[dedupKey, takenSec, tzSec]]]` | (none) — verified by reading back via `VrseUb` | live-verified |

## RPCs added for the library scan (2026-11-05)

Read-only checks ran in the signed-in tab (shapes and booleans printed, no content or keys).
Writes were checked with two synthetic 320×200 JPEGs (fake GPS, then moved to Trash) and a
test album "Pixlixir probe - safe to delete" (left for the user to delete).

| RPC | Purpose | Request | Response fields used | Status |
|---|---|---|---|---|
| `lcxiM` | Library timeline | `[pageId, startMs, 500, null, 1, 3]` | `[0]` rows (newest first), `[1]` next page id, `[2]` last timestamp. Row: `[0]` mediaKey, `[1][0]` base URL, `[1][1..2]` w/h, `[2]` taken ms, `[3]` dedupKey, `[4]` tz ms, last element = ext object (`76647426` video, `129168200[1][0]` = [latE7, lngE7]) | live-verified (ordering, paging, start time) |
| `Z5xsfc` | Albums | `[pageId, null, null, null, 1, null, null, 100, [2], 5]` | `[0]` rows: `[0]` album key, ext `72930366[1]` title; `[1]` next | live-verified; album URL `/album/<key>` uses the same key |
| `snAcKc` | Album items | `[albumKey, pageId, null, null]` | `[1]` rows (shape as `lcxiM`), `[2]` next (`""` when none) | live-verified. **Row `[0]` is an album-specific item key, not the library key**; `[3]` dedupKey matches. `VrseUb`/`fDcn4b` accept the album item key |
| `fDcn4b` | Item details | `[mediaKey, 1, null, null, 1]` | `[0][1]` description, `[0][11]` dedupKey, `[0][13][0]` / `[0][9][0]` [latE7, lngE7], `[0][19]` albums, `[0][23]` camera `[make, model, …]` | live-verified |
| `E1Cajb` | Add to own album | `[[mediaKeys], albumKey]` | response `[albumKey, …]` (not used); verified via `fDcn4b[0][19]` and album item count | live-verified |
| `laUYf` | Add to shared album | `[albumKey, [2, null, [[[key]]…], null, null, null, [1]]]` | — | implemented per GPTK, **not** live-verified |
| `AQNOFd` | Set description | `[null, text, dedupKey]` | `[]`; read back via `fDcn4b[0][1]` | live-verified |
| `OXvT9d` | Create album | `[title, null, 2]` | `[0][0]` album key | probe only (not used by Pixlixir) |
| `XwAOJf` | Move to trash | `[null, 1, [dedupKeys], 3]` | — ; items appear in `zy0IHe` (trash) and leave the timeline and albums | probe clean-up only |

Location on upload: an uploaded JPEG's EXIF GPS becomes the item's location immediately
(`fDcn4b[0][13][0]` = the EXIF coordinates ×1e7). EXIF `DateTimeOriginal` without an offset is
read as local time in an account zone (10:00 → 09:00Z in this account); Pixlixir sets the
capture time explicitly with `DaSgWe` after upload, so this does not matter.

Other RPCs seen in traffic or GPTK (not used yet): `swbisb` hash lookup (the web client calls
it before uploading), `EtUHOe` location of existing items, `zy0IHe` trash listing.

## Media bytes

| Rendition | Finding | Status |
|---|---|---|
| `baseUrl=wW-hH` | Resized JPEG | live-verified |
| `baseUrl=d` | Full-resolution image (1868×4000 test item, ~1.42 MB vs ~1.42 MB `=s0`). **Requires the user's cookies: HTTP 403 with `credentials: "omit"`.** Works from the photos.google.com origin with `credentials: "include"`. | live-verified |
| Byte-identity with the uploaded original | Not yet compared against a known original file | research |
| Video / HEIC / RAW originals | Not tested | research |

## Upload (web client flow, captured from the web app's own drag-and-drop upload)

1. `swbisb` with the SHA-1 of the file (optional duplicate check by the web client).
2. `POST /_/upload/uploadmedia/interactive?authuser=N` with headers
   `X-Goog-Upload-Command: start`, `X-Goog-Upload-Protocol: resumable`,
   `X-Goog-Upload-Header-Content-Length: <size>`, `X-Goog-Upload-File-Name`,
   `X-Goog-Hash: sha1=<base64>`; body is a 13–15 byte protobuf
   (`08 02 10 01 18 01 20 02 38 <varint size> 40 01`, sent as a UTF-8 string like the web client).
   Response header `x-goog-upload-url`.
3. `POST <upload-url>` with `X-Goog-Upload-Command: upload, finalize`, `X-Goog-Upload-Offset: 0`
   and the bytes. Response header `x-goog-upload-status: final`; body is the upload token
   (~488 base64 chars).
4. `mdpdU` commits the token → new item.

Pixlixir's implementation of 2–4 (+ `DaSgWe`) was verified end-to-end with the live probe:
a synthetic 480×320 JPEG uploaded, its date set to 2001-02-03T10:00Z and read back exactly.
The item was then moved to Trash.

## UI structure (for selection / contextual UI)

- Grid tile: `a[href*="/photo/<mediaKey>"]` (aria-label begins `Photo -` / `Video -`) with a sibling
  `[role=checkbox][aria-checked]`.
- Viewer: URL contains `/photo/<mediaKey>`.
- The SPA navigates with `history.pushState`; isolated-world scripts poll the URL.

## Open questions

- `/u/N` path prefix and upload `authuser` for secondary accounts — verify with a second login.
- Does `mdpdU` behave differently for very large files (chunked upload)? The web client sent
  a single `upload, finalize` for small files; `x-goog-upload-chunk-granularity` was 262144.
- Rate limits and failure envelopes for rejected writes.
- Upload quality setting (Storage saver vs Original) — which applies to uploads made this way.
