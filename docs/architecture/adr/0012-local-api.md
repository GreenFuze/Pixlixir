# ADR-0012: A Local API, through a helper Chrome starts

**Status:** accepted, 2026-11-14. Tested in Chromium against the stand-in Google Photos with the real
helper; not yet against the owner's library through the helper (Google's search was refusing the
owner's account at the time, see Measured).

## Context

The owner wants programs on their computer to read their Google Photos through Pixlixir, at the
least to find a photo's details from its file name. An extension cannot open a port. The sign-in
stays inside the Photos tab (ADR-0001), so any API has to go through Pixlixir.

## Decision

1. **A helper started by Chrome.** `pixlixir-helper` (Go, `helper/`) is registered with Chrome as the
   native messaging host `com.greenfuze.pixlixir`, for this Pixlixir's ID only. Switching **Local API**
   on in Settings makes the service worker call `connectNative`; Chrome starts the helper and joins
   its standard input and output to a port. Switching off closes the port; the helper's input ends
   and it exits. The open port keeps the service worker awake. It comes back on with Chrome when left on.
2. **The helper decides nothing.** It serves HTTP on 127.0.0.1 only, checks the key
   (`Authorization: Bearer`, constant-time compare), refuses any request with an `Origin` header or a
   `Host` other than 127.0.0.1 or localhost on its port (web pages and DNS rebinding), and passes each
   route on as an operation with its parameters as strings. Pixlixir checks every operation and
   parameter (`api-service.ts`, zod), so the rules live in one place.
3. **Messages** (JSON, each framed by a 4-byte little-endian length):
   - helper → Pixlixir: `hello` (version), `listening`, `listenFailed` (`PORT_IN_USE`, ...), `request` (id, op, params);
   - Pixlixir → helper: `config` (port, key) first, then `response` (id, json or error), or for a file a
     `response` with a `binary` header followed by numbered `chunk`s of 4 MB, base64.
4. **Read-only.** Status, find by file name, item details, original (photos), thumbnail, library pages,
   albums and album pages. The contract is `docs/api/openapi.yaml`.
5. **Find by file name** uses Google's own search (`EzkLib`), then reads each result's real file name
   (`EWgK9e`) and keeps those that match (exact ignoring case, extension optional; prefix; contains).
   At most 3 pages of 100 per request.
6. **Searches are rationed.** Per account, at least 3 s apart. When Google refuses (its code 8),
   no search is sent for 5 minutes and every find answers `429 RATE_LIMITED` with `Retry-After`.
7. **Install** is one command per system (`scripts/install/api-install.ps1|sh`), shown in Settings
   with this Pixlixir's ID filled in. It downloads the helper from the latest release and checks it
   against `pixlixir-helper-SHA256SUMS.txt`, then registers it for Chrome, Chromium, Edge and Brave:
   per-user registry keys on Windows, manifest files on macOS and Linux. No admin rights.
   `api-uninstall.*` removes the registrations, stops the helper and deletes it.

## Measured (2026-11-14, read-only, `/u/1`)

- `EzkLib` args `[null, null, pageToken, null, pageSize, null, 1, [query], 3, [1,1]]`; rows like the
  library listing's. Mode 2 (the search box's first call) returns no next-page token.
- Search is broad: an exact file name returned 1 to 68 items, the right one at rank 0 to 35, found in
  9 of 9 tries. So every result's name is checked.
- **Rate limit:** about 20 searches in 25 s made Google refuse every search (code 8). After about 40
  more at one per 3 s, a single search 50 minutes later was still refused. The full recovery time is
  unknown, and the refusal may also affect searching on the Photos website.

## Consequences

+ Any program on the computer can use it with plain HTTP; the helper only runs while switched on.
+ Nothing in the library can change through it.
− A Google Photos tab must be open and signed in.
− Finding by name depends on Google's search, which Google rations; heavy use gets `429` for minutes
  or longer. The safe rate is not known.
− Videos' original files are not served (the call for them is still unverified).
− The helper is a native program; on macOS it is not signed or notarised, so the installer clears
  the quarantine flag.
− Another program running as the same user can read the key from Chrome's storage or from Settings.
