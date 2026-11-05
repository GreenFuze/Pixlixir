# Developer tools (never shipped in the extension)

| Tool | Use |
|---|---|
| `npm run dev:split -- captures/<scan>.jpg` | Runs detection + auto-fix on a local image (Node). Writes `overlay.jpg` (detected outlines), per-stage masks, `print-N.jpg` (rectified) and `print-N-compare.jpg` (original / fixed / treated-mask) to `captures/debug/<name>/`. Note: Node decoding ignores EXIF orientation. |
| `serve.mjs` (`npm run dev:serve`) | Serves the repo root on 127.0.0.1:5174 with the **extension's CSP** (read from `manifest.json`), so WebAssembly/CSP problems show up before Chrome. |
| `editor-sandbox/` | Runs the real editors (`dist/split.js`, `dist/panorama.js`) as normal web pages with faked extension APIs and a fake Photos tab. With `npm run dev:serve` running, open `/tools/dev/editor-sandbox/?tab=1&email=dev@example.com&media=AF1QipSANDBOX0000000&img=/captures/<scan>.jpg` (Split) or `/tools/dev/editor-sandbox/panorama.html?tab=1&email=dev@example.com&media=AF1QipSANDBOX0000001,AF1QipSANDBOX0000002&img=/captures/a.jpg&img=/captures/b.jpg` (Panorama; one `img` per media key), or `/tools/dev/editor-sandbox/scan.html?tab=1&email=dev@example.com` (Library scan over a fake library built from `captures/pano`; add `&sel=sandbox` for a handed-over selection). "Saving" goes to an in-page mock; nothing reaches Google. |
| `../live-probe/` | Protocol probe for the real photos.google.com session (see the file header). |

`captures/` is gitignored: keep personal photos there and never commit them.
