/**
 * Strict accessors for Google's positional (array-indexed) JSON payloads.
 * Every read names the field and validates its type, so a protocol change
 * produces a precise RPC_UNEXPECTED_SHAPE error instead of garbage data.
 */

import { ErrorCode, PixError } from "../../shared/errors.js";

type Path = readonly (number | string)[];

export class PositionalReader {
  constructor(
    private readonly rpcId: string,
    private readonly root: unknown,
  ) {}

  at(path: Path): unknown {
    let cur: unknown = this.root;
    for (const step of path) {
      if (cur === null || cur === undefined) return undefined;
      if (typeof step === "number") {
        if (!Array.isArray(cur)) return undefined;
        cur = cur[step];
      } else {
        if (typeof cur !== "object") return undefined;
        cur = (cur as Record<string, unknown>)[step];
      }
    }
    return cur;
  }

  string(path: Path, field: string): string {
    const v = this.at(path);
    if (typeof v !== "string" || v.length === 0) throw this.shapeError(path, field, "non-empty string", v);
    return v;
  }

  number(path: Path, field: string): number {
    const v = this.at(path);
    if (typeof v !== "number" || !Number.isFinite(v)) throw this.shapeError(path, field, "number", v);
    return v;
  }

  optionalString(path: Path): string | null {
    const v = this.at(path);
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  optionalNumber(path: Path): number | null {
    const v = this.at(path);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  array(path: Path, field: string): unknown[] {
    const v = this.at(path);
    if (!Array.isArray(v)) throw this.shapeError(path, field, "array", v);
    return v;
  }

  private shapeError(path: Path, field: string, expected: string, actual: unknown): PixError {
    return new PixError(ErrorCode.RpcUnexpectedShape, `Google Photos response for ${this.rpcId} changed: ${field} is not a ${expected}.`, {
      rpcId: this.rpcId,
      field,
      path: path.join("."),
      actualType: actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual,
    });
  }
}
