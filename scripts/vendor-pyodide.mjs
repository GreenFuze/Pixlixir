// Vendors the Python runtime used by the panorama stitcher into vendor/pyodide/:
// the Pyodide runtime (from the pinned npm package) plus pinned, sha256-verified
// wheels for numpy, OpenCV, Pillow (Pyodide builds) and OpenStitching (PyPI).
// Everything ships inside the extension: MV3 forbids loading remote code at runtime.
// Usage: node scripts/vendor-pyodide.mjs   (idempotent; re-downloads only missing/invalid files)
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class PyodideVendor {
  static OUT = "vendor/pyodide";
  /** Runtime files copied from the npm package (must match its pinned version). */
  static RUNTIME = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
  /** Pyodide-built packages resolved through pyodide-lock.json (hash from the lock file). */
  static LOCKED = ["numpy", "opencv-python", "pillow"];
  /** Pure-Python wheels from PyPI, pinned by version and sha256 (both Apache-2.0). */
  static PYPI = [
    {
      name: "stitching",
      version: "0.7.0",
      depends: ["opencv-python", "numpy", "largestinteriorrectangle"],
      file: "stitching-0.7.0-py3-none-any.whl",
      url: "https://files.pythonhosted.org/packages/b1/3f/0350ac5d45972d71c6f8b41fa902ce06d9d9cd4e7a06651f482f26578e55/stitching-0.7.0-py3-none-any.whl",
      sha256: "71b4dbbf90365298c129d59f65a6607726130f0c3e8657fc883f7045f6b583d7",
    },
    {
      name: "largestinteriorrectangle",
      version: "0.2.1",
      depends: ["numpy"], // numba is replaced by a shim at runtime (see stitch-runtime.ts)
      file: "largestinteriorrectangle-0.2.1-py3-none-any.whl",
      url: "https://files.pythonhosted.org/packages/9a/06/d5cf3f16076e10debef57d4a29583a443117e07696a77fd33acb6ee24ede/largestinteriorrectangle-0.2.1-py3-none-any.whl",
      sha256: "ff84fc9659ebcf6445ce3ec14eb083c9301f06260c5b58c429e8bf46efe91fdb",
    },
  ];

  constructor(out = PyodideVendor.OUT) {
    this.out = out;
    const require = createRequire(import.meta.url);
    this.pkgDir = path.dirname(require.resolve("pyodide/package.json"));
    this.version = require("pyodide/package.json").version;
  }

  async run() {
    await mkdir(this.out, { recursive: true });

    // Paragraph: runtime files straight from the pinned npm package.
    for (const f of PyodideVendor.RUNTIME) await copyFile(path.join(this.pkgDir, f), path.join(this.out, f));

    // Paragraph: Pyodide-built wheels, verified against the hashes in pyodide-lock.json.
    const lock = JSON.parse(await readFile(path.join(this.out, "pyodide-lock.json"), "utf8"));
    const cdn = `https://cdn.jsdelivr.net/pyodide/v${this.version}/full/`;
    for (const name of PyodideVendor.LOCKED) {
      const pkg = lock.packages[name];
      if (!pkg) throw new Error(`[vendor] ${name} is missing from pyodide-lock.json (pyodide ${this.version})`);
      for (const dep of pkg.depends) {
        if (!PyodideVendor.LOCKED.includes(dep)) throw new Error(`[vendor] ${name} depends on ${dep}, which is not vendored. Add it to PyodideVendor.LOCKED.`);
      }
      await this.ensure(pkg.file_name, cdn + pkg.file_name, pkg.sha256);
    }

    // Paragraph: pinned PyPI wheels, registered in our copy of the lock file so Pyodide loads them
    // by name with the same integrity check as its own packages.
    for (const w of PyodideVendor.PYPI) {
      await this.ensure(w.file, w.url, w.sha256);
      lock.packages[w.name] = { name: w.name, version: w.version, file_name: w.file, install_dir: "site", sha256: w.sha256, package_type: "package", imports: [w.name], depends: w.depends, unvendored_tests: false, tool: {} };
    }
    await writeFile(path.join(this.out, "pyodide-lock.json"), JSON.stringify(lock));

    // Paragraph: manifest consumed by the stitch runtime.
    const manifest = { pyodideVersion: this.version, packages: [...PyodideVendor.LOCKED, ...PyodideVendor.PYPI.map((w) => w.name)] };
    await writeFile(path.join(this.out, "vendor-manifest.json"), JSON.stringify(manifest, null, 2));
    return manifest;
  }

  async ensure(file, url, sha256) {
    const dest = path.join(this.out, file);
    if (await this.valid(dest, sha256)) return;
    console.log(`[vendor] downloading ${file}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`[vendor] ${url} -> HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== sha256) throw new Error(`[vendor] sha256 mismatch for ${file}: expected ${sha256}, got ${got}`);
    await writeFile(dest, bytes);
  }

  async valid(file, sha256) {
    try {
      await stat(file);
    } catch {
      return false;
    }
    return createHash("sha256").update(await readFile(file)).digest("hex") === sha256;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = await new PyodideVendor().run();
  console.log(`[vendor] pyodide ${m.pyodideVersion} ready in ${PyodideVendor.OUT}`);
}
