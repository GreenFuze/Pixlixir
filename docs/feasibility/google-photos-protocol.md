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

Other RPCs seen in traffic or GPTK (not used yet): `lcxiM` library page, `swbisb` hash lookup
(the web client calls it before uploading), `Z5xsfc` albums, `XwAOJf` trash/restore, `EtUHOe`
location, `AQNOFd` description, `OXvT9d`/`E1Cajb` albums. See the master list for status.

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
