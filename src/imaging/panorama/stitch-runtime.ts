/**
 * Panorama stitching runtime: Pyodide (CPython in WebAssembly) + OpenCV + OpenStitching,
 * driven by pixlixir_stitch.py. Runs in a Web Worker in the extension and in Node for
 * tests and developer tools — the caller supplies `loadPyodide` and the asset locations.
 *
 * RAII: StitchRuntime.create() acquires the interpreter and the engine; dispose() releases them.
 */

import type { loadPyodide as LoadPyodide, PyodideAPI } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import type { GeoPoint } from "../../domain/types.js";
import { ErrorCode, PixError } from "../../shared/errors.js";

export type Motion = "rotate" | "flat";
export type Projection = "spherical" | "cylindrical" | "perspective" | "panini" | "mercator" | "fisheye" | "stereographic";
export type Straighten = "horizontal" | "vertical" | "auto" | "off";
export type Edges = "crop" | "fill";

export interface StitchSettings {
  motion: Motion;
  /** Only for motion "rotate". */
  projection: Projection;
  /** Only for motion "rotate": wave correction (keeps the horizon straight). */
  straighten: Straighten;
  edges: Edges;
  /** Accept weaker matches and register at higher resolution (slower). */
  tryHarder: boolean;
}

/** What a saved panorama inherits: EXIF of the earliest photo plus the time/location Google Photos shows for it. */
export interface OutputMetadata {
  /** The first bytes of the earliest source file (its EXIF header), or null. */
  sourceHead: Uint8Array | null;
  takenAtMs: number | null;
  timezoneOffsetMs: number;
  location: GeoPoint | null;
}

export type StitchOutput = { kind: "preview" } | { kind: "full"; maxMegapixels: number; metadata?: OutputMetadata };

/** Panorama groups found among loaded photos (keys in capture order). */
export interface OverlapGroups {
  groups: { keys: number[]; duplicates: number[] }[];
  pairs: number;
  seconds: number;
}

export interface StitchResult {
  jpeg: Uint8Array;
  width: number;
  height: number;
  /** Image keys that made it into the panorama, and those that could not be connected. */
  used: number[];
  dropped: number[];
  /** Share of the output that was filled in (made-up content), 0 when cropping. */
  filledFraction: number;
  /** Preview only: PNG overlay marking filled areas, or null. */
  fillOverlayPng: Uint8Array | null;
  /** True when a full render was reduced to stay under maxMegapixels. */
  capped: boolean;
  /** Linear factor from this render to the photos' original resolution (1 for uncapped full renders). */
  scaleToFull: number;
  /** Area of the output in units of one photo, and its short side in units of a photo's short side. */
  viewGain: number;
  shortSide: number;
  seconds: number;
  /** Non-fatal notes (e.g. EXIF that could not be copied). */
  warnings: string[];
}

export interface RuntimeAssets {
  /** Directory URL (browser) or path (Node) holding the vendored Pyodide files, with a trailing slash. */
  indexURL: string;
  /** Packages to load by name from the vendored pyodide-lock.json (vendor-manifest.json "packages"). */
  packages: string[];
  /** Source of pixlixir_stitch.py. */
  driverSource: string;
}

export const DEFAULT_STITCH_SETTINGS: StitchSettings = { motion: "rotate", projection: "spherical", straighten: "horizontal", edges: "crop", tryHarder: false };

/** Makes largestinteriorrectangle (which uses numba's @njit) run as plain Python: numba is not available in Pyodide. */
const NUMBA_SHIM = `
def njit(*args, **kwargs):
    if args and callable(args[0]) and not kwargs:
        return args[0]
    return lambda f: f
jit = njit
def prange(*args):
    return range(*args)
class _Type:
    def __getattr__(self, name): return self
    def __getitem__(self, key): return self
    def __call__(self, *args, **kwargs): return self
types = _Type()
uint32 = int32 = int64 = float64 = boolean = types
`;

export class StitchRuntime {
  readonly #py: PyodideAPI;
  #engine: PyProxy | null;

  private constructor(py: PyodideAPI, engine: PyProxy) {
    this.#py = py;
    this.#engine = engine;
  }

  static async create(loadPyodide: typeof LoadPyodide, assets: RuntimeAssets, onProgress: (stage: string) => void): Promise<StitchRuntime> {
    let py: PyodideAPI;
    try {
      // Paragraph: interpreter + packages, all from the vendored, hash-checked copy.
      py = await loadPyodide({ indexURL: assets.indexURL });
      const failures: string[] = [];
      await py.loadPackage(assets.packages, { messageCallback: () => {}, errorCallback: (m: string) => failures.push(m) });
      if (failures.length > 0) throw new Error(failures.join("; "));

      // Paragraph: numba shim and our driver as importable modules.
      py.FS.mkdirTree("/pixlixir/numba");
      py.FS.writeFile("/pixlixir/numba/__init__.py", NUMBA_SHIM);
      py.FS.writeFile("/pixlixir/pixlixir_stitch.py", assets.driverSource);
      py.runPython("import sys\nif '/pixlixir' not in sys.path: sys.path.insert(0, '/pixlixir')");
    } catch (err) {
      throw PixError.wrap(err, ErrorCode.RuntimeUnavailable, "The panorama engine could not start", { indexURL: assets.indexURL });
    }

    // Paragraph: the engine (import errors here mean a broken vendor bundle).
    try {
      const module = py.pyimport("pixlixir_stitch") as PyProxy & { PanoramaEngine: (progress: (s: string) => void) => PyProxy };
      const engine = module.PanoramaEngine((stage: string) => onProgress(stage));
      module.destroy();
      return new StitchRuntime(py, engine);
    } catch (err) {
      throw StitchRuntime.fromPython(err, ErrorCode.RuntimeUnavailable, "The panorama engine failed to initialise");
    }
  }

  dispose(): void {
    this.#engine?.destroy();
    this.#engine = null;
  }

  setImage(key: number, rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): void {
    if (rgba.length !== width * height * 4) throw new PixError(ErrorCode.InvalidImage, "Image buffer does not match its size", { key, width, height, bytes: rgba.length });
    try {
      this.engine().set_image(key, rgba, width, height);
    } catch (err) {
      throw StitchRuntime.fromPython(err, ErrorCode.InvalidImage, "Could not load a photo into the panorama engine", { key, width, height });
    }
  }

  removeImage(key: number): void {
    this.engine().remove_image(key);
  }

  stitch(keys: number[], settings: StitchSettings, output: StitchOutput): StitchResult {
    // Paragraph: run the Python pipeline.
    const pySettings = this.#py.toPy({
      motion: settings.motion,
      projection: settings.projection,
      straighten: settings.straighten,
      edges: settings.edges,
      try_harder: settings.tryHarder,
      output: output.kind,
      max_megapix: output.kind === "full" ? output.maxMegapixels : 0,
      // Pyodide maps JS null to JsNull (truthy in Python), so absent values are left out instead.
      ...(output.kind === "full" && output.metadata ? { metadata: StitchRuntime.pyMetadata(output.metadata) } : {}),
    }) as PyProxy;
    const pyKeys = this.#py.toPy(keys) as PyProxy;
    let raw: PyProxy;
    try {
      raw = this.engine().stitch(pyKeys, pySettings) as PyProxy;
    } catch (err) {
      throw StitchRuntime.fromPython(err, ErrorCode.StitchFailed, "Stitching failed unexpectedly", { keys: keys.length, output: output.kind });
    } finally {
      pySettings.destroy();
      pyKeys.destroy();
    }

    // Paragraph: convert to plain JS and map library failures to stable error codes.
    const r = raw.toJs({ dict_converter: Object.fromEntries }) as Record<string, unknown>;
    raw.destroy();
    const error = r.error as { code: string; message: string } | undefined;
    if (error) {
      const code = error.code === "NOT_CONNECTED" || error.code === "NEED_MORE" ? ErrorCode.StitchNotConnected : ErrorCode.StitchFailed;
      throw new PixError(code, StitchRuntime.friendly(error.code, error.message), { reason: error.code, library: error.message });
    }
    return {
      jpeg: StitchRuntime.bytes(r.jpeg, "jpeg"),
      width: Number(r.width),
      height: Number(r.height),
      used: (r.used as number[]).map(Number),
      dropped: (r.dropped as number[]).map(Number),
      filledFraction: Number(r.filled_fraction),
      fillOverlayPng: r.fill_png == null ? null : StitchRuntime.bytes(r.fill_png, "fill_png"),
      capped: Boolean(r.capped),
      scaleToFull: Number(r.scale_to_full),
      viewGain: Number(r.view_gain),
      shortSide: Number(r.short_side),
      seconds: Number(r.seconds),
      warnings: (r.warnings as unknown[]).map(String),
    };
  }

  /** Which loaded photos overlap into panoramas (keys in capture order). */
  findGroups(keys: number[]): OverlapGroups {
    const pyKeys = this.#py.toPy(keys) as PyProxy;
    let raw: PyProxy;
    try {
      raw = this.engine().find_groups(pyKeys) as PyProxy;
    } catch (err) {
      throw StitchRuntime.fromPython(err, ErrorCode.StitchFailed, "Checking which photos overlap failed", { keys: keys.length });
    } finally {
      pyKeys.destroy();
    }
    const r = raw.toJs({ dict_converter: Object.fromEntries }) as { groups: { keys: unknown[]; duplicates: unknown[] }[]; pairs: unknown; seconds: unknown };
    raw.destroy();
    return {
      groups: r.groups.map((g) => ({ keys: g.keys.map(Number), duplicates: g.duplicates.map(Number) })),
      pairs: Number(r.pairs),
      seconds: Number(r.seconds),
    };
  }

  // ---- internals -----------------------------------------------------------

  private engine(): PyProxy & Record<string, (...args: unknown[]) => unknown> {
    if (!this.#engine) throw new PixError(ErrorCode.RuntimeUnavailable, "The panorama engine was already disposed");
    return this.#engine as PyProxy & Record<string, (...args: unknown[]) => unknown>;
  }

  private static pyMetadata(m: OutputMetadata): Record<string, unknown> {
    return {
      offset_ms: m.timezoneOffsetMs,
      ...(m.sourceHead ? { source_head: m.sourceHead } : {}),
      ...(m.takenAtMs !== null ? { taken_ms: m.takenAtMs } : {}),
      ...(m.location ? { gps: [m.location.latitude, m.location.longitude] } : {}),
    };
  }

  private static bytes(value: unknown, field: string): Uint8Array {
    if (value instanceof Uint8Array) return value;
    throw new PixError(ErrorCode.Internal, `Panorama engine returned an unexpected ${field}`, { type: Object.prototype.toString.call(value) });
  }

  private static friendly(code: string, library: string): string {
    switch (code) {
      case "NOT_CONNECTED":
        return "These photos could not be connected: they need to overlap by roughly a third, with shared detail. Try 'Try harder', or remove photos that don't overlap.";
      case "NEED_MORE":
        return "Select at least two overlapping photos.";
      case "ALIGNMENT":
        return "The photos matched, but their positions could not be worked out. If the camera moved across a flat subject, choose 'Moving over a flat surface'; otherwise try another projection or 'Try harder'.";
      case "CROP":
        return "The stitched photos leave no clean rectangle to crop to. Choose 'Fill edges' instead.";
      default:
        return `Stitching failed: ${library}`;
    }
  }

  /** Python exceptions arrive as PythonError (type + traceback); keep the type and the last traceback line. */
  private static fromPython(err: unknown, code: ErrorCode, message: string, details: Record<string, unknown> = {}): PixError {
    const pyType = (err as { type?: unknown }).type;
    const text = err instanceof Error ? err.message : String(err);
    const last = text.trim().split("\n").pop() ?? text;
    if (pyType === "MemoryError" || /out of memory|Cannot enlarge memory/i.test(text)) {
      return new PixError(ErrorCode.OutOfMemory, "Not enough memory for a panorama this large. Choose a smaller output size or fewer photos.", { ...details, python: last });
    }
    return PixError.wrap(err, code, message, { ...details, pythonType: typeof pyType === "string" ? pyType : null, python: last });
  }
}
