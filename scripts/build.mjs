// Builds the unpacked extension into dist/. Usage: node scripts/build.mjs [--watch]
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { IconFactory } from "./icons.mjs";

const OUT = "dist";
const watch = process.argv.includes("--watch");

// Paragraph: clean output and copy static assets.
await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/icons`, { recursive: true });
const statics = [
  ["src/extension/manifest.json", "manifest.json"],
  ["src/extension/ui/base.css", "base.css"],
  ["src/extension/sidepanel/sidepanel.html", "sidepanel.html"],
  ["src/extension/sidepanel/sidepanel.css", "sidepanel.css"],
  ["src/extension/editor/split.html", "split.html"],
  ["src/extension/editor/split.css", "split.css"],
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
];
for (const [from, to] of statics) await cp(from, `${OUT}/${to}`);
await new IconFactory().writeAll(`${OUT}/icons`, [16, 32, 48, 128]);

// Paragraph: bundle scripts. Content script must be a classic script (IIFE).
const common = { bundle: true, target: "chrome116", sourcemap: true, logLevel: "info", jsx: "automatic", jsxImportSource: "preact", legalComments: "linked" };
const contexts = await Promise.all([
  esbuild.context({ ...common, entryPoints: { content: "src/extension/content/content.ts" }, format: "iife", outdir: OUT }),
  esbuild.context({
    ...common,
    entryPoints: {
      background: "src/extension/background/service-worker.ts",
      sidepanel: "src/extension/sidepanel/sidepanel.tsx",
      split: "src/extension/editor/split.tsx",
      "split-worker": "src/extension/editor/split-worker.ts",
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
