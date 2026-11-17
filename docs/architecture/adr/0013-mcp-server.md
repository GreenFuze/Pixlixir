# ADR-0013: An MCP server, as a mode of the helper

**Status:** accepted, 2026-11-14. Tested with an in-memory MCP client against a stand-in API; not yet
from the Claude desktop app against the owner's library.

## Context

The owner wants Claude (desktop app, Cowork) to use Pixlixir. Claude's shell runs in a sandboxed VM
whose only network path is an allowlist proxy, so it cannot reach 127.0.0.1 (verified by the other
session: the proxy answered 403). The supported path is a stdio MCP server registered in the Claude
desktop app's configuration, which runs natively on the PC.

## Decision

1. **`pixlixir-helper mcp`** is the MCP server (official Go SDK, `modelcontextprotocol/go-sdk`, MIT /
   Apache-2.0). Same binary as the native host, so there is one install.
2. **It is a client of the Local API**, not a second way into Pixlixir: everything goes through
   127.0.0.1 with the key, so the API's rules (read-only, checks in Pixlixir) hold.
3. **No key to copy.** While listening, the helper writes `connection.json` next to itself (port, key,
   pid; mode 0600; in the user's own folder) and removes it when it stops. The MCP server reads it on
   every call and once more after a 401. No file means the API is off: a clear error, not a hang.
   (The key does not change when the extension restarts; only **New key** changes it.)
4. **Tools:** status, search (the search box's free text, filtered by kind and time), find by file
   name, item details, library and album listings with file names, thumbnails as image content (16 at
   most), and download. Results are the API's compact JSON; batch tools report per item.
5. **Downloads** go only into folders listed in `PIXLIXIR_DOWNLOAD_ROOTS` (checked before and after
   following links), are streamed, never overwrite (" (1)" is added), and a broken download leaves no
   file. Names are cleaned of folder parts and reserved characters; any script works (Hebrew tested).
6. **The API grew for it:** `GET /v1/search`; `after`, `mediaType` and `limit` on the library with
   file names on listed items; `durationSec` for videos (the listing's video data, first number, in ms:
   17,899 against 17.9 s played, read-only 2026-11-14); video originals. Searches are now at least 10 s
   apart.
7. **Video originals** come from `baseUrl=dv`, which redirects to Google file hosts that do not let the
   page read the file. Pixlixir's service worker fetches it instead, with the browser's cookies, after
   asking for `*.googleusercontent.com` and `*.usercontent.google.com` when the API is switched on.
   Whether `=dv` is the uploaded file or a re-encoding is not proven: one video played 2.616 s where the
   listing says 2.566 s.

## Consequences

+ Claude works with the library through tools, without network access from its sandbox.
− Search stays rationed by Google; `list_library` with a time window is the way when a date is known.
− People (face groups) are not built: the People page's call (`yQelMe`) was seen but its request
  could not be captured read-only that day.
− Video downloads are untested against the real site.
