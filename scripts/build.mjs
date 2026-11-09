// Builds the unpacked extension into dist/. Usage: node scripts/build.mjs [--watch] [--out=folder]
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { IconFactory } from "./icons.mjs";
import { PyodideVendor } from "./vendor-pyodide.mjs";

const OUT = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "dist";
const watch = process.argv.includes("--watch");

// Paragraph: clean output and copy static assets.
await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/icons`, { recursive: true });
const statics = [
  ["src/extension/manifest.json", "manifest.json"],
  ["src/extension/ui/base.css", "base.css"],
  ["src/extension/sidepanel/sidepanel.html", "sidepanel.html"],
  ["src/extension/sidepanel/sidepanel.css", "sidepanel.css"],
  ["src/extension/editor/editor.css", "editor.css"],
  ["src/extension/editor/fix/fix.css", "fix.css"],
  ["src/extension/editor/split.html", "split.html"],
  ["src/extension/editor/split.css", "split.css"],
  ["src/extension/editor/panorama/panorama.html", "panorama.html"],
  ["src/extension/editor/panorama/panorama.css", "panorama.css"],
  ["src/extension/editor/edit/edit.html", "edit.html"],
  ["src/extension/editor/edit/edit.css", "edit.css"],
  ["src/extension/editor/edit/upscale.html", "upscale.html"],
  ["src/extension/editor/upscale/upscale.css", "upscale.css"],
  ["src/extension/scan/scan.html", "scan.html"],
  ["src/extension/scan/scan.css", "scan.css"],
  ["src/extension/settings/settings.html", "settings.html"],
  ["src/extension/settings/settings.css", "settings.css"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
];
for (const [from, to] of statics) await cp(from, `${OUT}/${to}`);
await new IconFactory().writeAll(`${OUT}/icons`, [16, 32, 48, 128]);

// Paragraph: Upscale's model (ADR-0010) and ONNX Runtime Web's WebAssembly, shipped inside the extension.
await mkdir(`${OUT}/models`, { recursive: true });
for (const f of ["realesr-general-x4v3-grain.onnx", "LICENSE-Real-ESRGAN.txt"]) await cp(`src/extension/models/${f}`, `${OUT}/models/${f}`);
await mkdir(`${OUT}/ort`, { recursive: true });
for (const f of ["ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.asyncify.mjs"]) await cp(`node_modules/onnxruntime-web/dist/${f}`, `${OUT}/ort/${f}`);
await cp("src/extension/models/LICENSE-onnxruntime.txt", `${OUT}/ort/LICENSE-onnxruntime.txt`);

// Paragraph: panorama engine runtime (Pyodide + pinned, hash-verified wheels), shipped inside the extension.
await new PyodideVendor().run();
await cp(PyodideVendor.OUT, `${OUT}/pyodide`, { recursive: true });

// Paragraph: bundle scripts. Content script must be a classic script (IIFE).
const common = { bundle: true, target: "chrome116", sourcemap: true, logLevel: "info", jsx: "automatic", jsxImportSource: "preact", legalComments: "linked", loader: { ".py": "text" } };
const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: { content: "src/extension/content/content.ts" }, format: "iife", outdir: OUT }),
  esbuild.context({
    ...common,
    entryPoints: {
      background: "src/extension/background/service-worker.ts",
      sidepanel: "src/extension/sidepanel/sidepanel.tsx",
      split: "src/extension/editor/split.tsx",
      "split-worker": "src/extension/editor/split-worker.ts",
      panorama: "src/extension/editor/panorama/panorama.tsx",
      "panorama-worker": "src/extension/editor/panorama/panorama-worker.ts",
      edit: "src/extension/editor/edit/edit.tsx",
      upscale: "src/extension/editor/edit/upscale.tsx",
      "upscale-worker": "src/extension/editor/upscale/upscale-worker.ts",
      scan: "src/extension/scan/scan.tsx",
      settings: "src/extension/settings/settings.tsx",
    },
    format: "esm",
    outdir: OUT,
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("watching…");
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log(`built ${OUT}/`);
}
