# Developer tools (never shipped in the extension)

| Tool | Use |
|---|---|
| `npm run dev:split -- captures/<scan>.jpg` | Runs detection + auto-fix on a local image (Node). Writes `overlay.jpg` (detected outlines), per-stage masks, `print-N.jpg` (rectified) and `print-N-compare.jpg` (original / fixed / treated-mask) to `captures/debug/<name>/`. Note: Node decoding ignores EXIF orientation. |
| `editor-sandbox/` | Runs the real split editor (`dist/split.js`) as a normal web page with faked extension APIs and a fake Photos tab. Serve the repo root locally (e.g. `python -m http.server 5174 --bind 127.0.0.1`) and open `/tools/dev/editor-sandbox/?tab=1&email=dev@example.com&media=AF1QipSANDBOX0000000&img=/captures/<scan>.jpg`. "Saving" goes to an in-page mock; nothing reaches Google. |
| `../live-probe/` | Protocol probe for the real photos.google.com session (see the file header). |

`captures/` is gitignored: keep personal photos there and never commit them.
