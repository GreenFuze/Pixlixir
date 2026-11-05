// Dev-only static server for the editor sandboxes. Serves the repo root on 127.0.0.1 with the
// SAME Content-Security-Policy as the extension pages (manifest.json), so CSP problems
// (e.g. WebAssembly in the panorama worker) show up here before they reach Chrome.
// Usage: node tools/dev/serve.mjs [port] [build folder served as /dist, e.g. dist-dev]
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

class DevServer {
  static TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
    ".map": "application/json", ".wasm": "application/wasm", ".zip": "application/zip", ".whl": "application/zip", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  };

  constructor(root, port, csp, build = "dist") {
    this.root = path.resolve(root);
    this.build = build;
    this.port = port;
    this.csp = csp;
  }

  start() {
    createServer((req, res) => void this.handle(req, res)).listen(this.port, "127.0.0.1", () => console.log(`[serve] http://127.0.0.1:${this.port}/  CSP: ${this.csp}`));
  }

  async handle(req, res) {
    // Paragraph: resolve the path safely inside the root.
    const url = new URL(req.url ?? "/", "http://localhost");
    const wanted = decodeURIComponent(url.pathname).replace(/^\/dist\//, `/${this.build}/`);
    let file = path.resolve(this.root, "." + wanted);
    if (!file.startsWith(this.root)) return this.fail(res, 403, "outside root");
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
      await stat(file);
    } catch {
      return this.fail(res, 404, url.pathname);
    }

    // Paragraph: stream it with the extension's CSP.
    res.writeHead(200, { "Content-Type": DevServer.TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Content-Security-Policy": this.csp, "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  }

  fail(res, status, what) {
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(`${status} ${what}`);
  }
}

const manifest = JSON.parse(await readFile("src/extension/manifest.json", "utf8"));
new DevServer(".", Number(process.argv[2] ?? 5174), manifest.content_security_policy.extension_pages, process.argv[3]).start();
