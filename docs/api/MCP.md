# Pixlixir as an MCP server (Claude and other MCP clients)

`pixlixir-helper mcp` is an MCP server over stdio. It is the same program as the Local API helper,
and a client of that API: it needs no key and no address, because it reads them from the helper's
private connection file each time (a new key in Settings needs no change here). Read-only; the
only thing it writes is downloaded files, into folders you allow.

## Set up

1. Install the helper: Pixlixir **Settings › Local API › Install** (one line), then switch **Local API**
   on. Keep Chrome open with a Google Photos tab.
2. Add the server to the Claude desktop app's configuration: `%APPDATA%\Claude\claude_desktop_config.json`
   on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS. The helper's
   installer prints this with your paths filled in:

   ```json
   {
     "mcpServers": {
       "pixlixir": {
         "command": "C:\\Users\\<you>\\AppData\\Local\\Pixlixir-Helper\\pixlixir-helper.exe",
         "args": ["mcp"],
         "env": { "PIXLIXIR_DOWNLOAD_ROOTS": "C:\\Users\\<you>\\Downloads\\Pixlixir" }
       }
     }
   }
   ```

   `PIXLIXIR_DOWNLOAD_ROOTS` lists the folders downloads may go into, separated by `;` on Windows and
   `:` elsewhere. Any language works in paths (Hebrew included).
3. Fully quit and reopen the Claude desktop app.

## Tools

| Tool | What it does |
|---|---|
| `pixlixir_status` | Whether the API runs, and which accounts are open |
| `search_photos(query, mediaType?, from?, to?, limit?, pageToken?)` | Google Photos' own search: people, places, things, dates |
| `find_by_filename(fileName, match?, limit?)` | By file name; exact ignores case and extension |
| `get_item(mediaKey)` | Everything known about one item |
| `list_library(before?, after?, mediaType?, limit?, pageToken?)` | The library, newest first; not rate-limited |
| `list_albums(pageToken?)`, `list_album_items(albumKey, pageToken?)` | Albums and their items |
| `get_thumbnails(mediaKeys[≤16], size?)` | Pictures returned inline |
| `download(mediaKeys[], destDir, kind?, size?)` | Original files (photos and videos) or thumbnails, never overwriting |

Every item has `takenAt` with its offset; videos have `durationSec` when Google gives it. Every tool
takes `account` when more than one Google account is open.

## Limits

- **Search is rationed by Google.** One search at most every 10 s per account; a refusal answers
  `RATE_LIMITED` with `retryAfterSeconds`, and Pixlixir asks Google again only after 5 minutes.
  Google's own lock has lasted over 50 minutes after a burst. Prefer `list_library` with a time window
  when a date is known.
- **People** (face groups) are not available yet.
- A Google Photos tab must be open and signed in.
