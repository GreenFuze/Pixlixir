/**
 * Filename formats the user knows, e.g. IMG-yyyymmdd.* or *yyyymmdd?hhmmss*.*
 *
 * Mask language: yyyy mm dd hh ss are the date parts (mm after hh is minutes, otherwise the
 * month), * is any text, ? is any one character, everything else is literal. Case never matters
 * when matching. A date part written against another letter of the same case is literal text,
 * so "Message" and "Summer" are safe in a mask.
 *
 * No library takes a filename plus a template like this (date-fns only parses an isolated
 * date), so a mask compiles to a regular expression with every literal escaped.
 */

import { ErrorCode, PixError } from "../shared/errors.js";

export interface FilenameFormatEntry {
  mask: string;
  /** The name's time is UTC (Pixel), not the time on the camera's clock. */
  utc: boolean;
}

/** A date read from a file name. localMs is its wall-clock time written as if it were UTC. */
export interface FilenameStamp {
  mask: string;
  localMs: number;
  hasTime: boolean;
  utc: boolean;
}

interface MaskGroups {
  y: string;
  mo: string;
  d: string;
  h?: string;
  mi?: string;
  s?: string;
}

const PART_RUN = /(?:yyyy|mm|dd|hh|ss)+/gi;
const PART = /yyyy|mm|dd|hh|ss/gi;
const MIN_YEAR = 1990;

export class FilenameFormat {
  static readonly MAX_MASK_LENGTH = 100;

  readonly #regex: RegExp;
  readonly hasTime: boolean;

  /** Throws a PixError with a message fit to show next to the input. */
  constructor(readonly entry: FilenameFormatEntry) {
    const mask = entry.mask.trim();
    if (mask.length === 0) throw FilenameFormat.invalid(entry.mask, "Enter a format.");
    if (mask.length > FilenameFormat.MAX_MASK_LENGTH) throw FilenameFormat.invalid(entry.mask, `Keep it under ${FilenameFormat.MAX_MASK_LENGTH} characters.`);

    // Paragraph: literal text and date parts, in order.
    const seen = new Set<string>();
    let pattern = "";
    let literalFrom = 0;
    for (const run of mask.matchAll(PART_RUN)) {
      if (!FilenameFormat.standsAlone(mask, run.index, run[0])) continue;
      pattern += FilenameFormat.literal(mask.slice(literalFrom, run.index)) + "(?<!\\d)";
      for (const part of run[0].match(PART)!) pattern += FilenameFormat.group(part.toLowerCase(), seen, entry.mask);
      literalFrom = run.index + run[0].length;
    }
    pattern += FilenameFormat.literal(mask.slice(literalFrom));

    // Paragraph: the parts must make a date, and a time only with hours and minutes.
    if (!seen.has("y") || !seen.has("mo") || !seen.has("d")) throw FilenameFormat.invalid(entry.mask, "Needs yyyy, mm and dd.");
    if (seen.has("h") !== seen.has("mi")) throw FilenameFormat.invalid(entry.mask, "A time needs both hh and mm.");
    this.hasTime = seen.has("h");
    this.#regex = new RegExp(`^${pattern}$`, "i");
  }

  /** The stamp in this name, or null. Digits that only look like a date (month 13) are not a match. */
  parse(fileName: string, nowYear: number = new Date().getUTCFullYear()): FilenameStamp | null {
    const groups = this.#regex.exec(fileName)?.groups as MaskGroups | undefined;
    if (!groups) return null;
    const year = Number(groups.y);
    if (year < MIN_YEAR || year > nowYear + 1) return null;
    const localMs = FilenameFormat.wallClock(year, Number(groups.mo), Number(groups.d), Number(groups.h ?? 0), Number(groups.mi ?? 0), Number(groups.s ?? 0));
    return localMs === null ? null : { mask: this.entry.mask, localMs, hasTime: this.hasTime, utc: this.entry.utc };
  }

  /** A run touching another letter of the same case is part of a word ("Message", "SUMMER"). */
  private static standsAlone(mask: string, index: number, run: string): boolean {
    const sameCaseLetter = (neighbour: string | undefined, edge: string) => {
      if (neighbour === undefined || !/[a-z]/i.test(neighbour)) return false;
      return (neighbour === neighbour.toLowerCase()) === (edge === edge.toLowerCase());
    };
    return !sameCaseLetter(mask[index - 1], run[0]!) && !sameCaseLetter(mask[index + run.length], run[run.length - 1]!);
  }

  private static group(part: string, seen: Set<string>, mask: string): string {
    const name = part === "yyyy" ? "y" : part === "dd" ? "d" : part === "hh" ? "h" : part === "ss" ? "s" : seen.has("h") && !seen.has("mi") ? "mi" : "mo";
    if (seen.has(name)) throw FilenameFormat.invalid(mask, `${part} appears twice. Use * for other text.`);
    seen.add(name);
    return `(?<${name}>\\d{${part.length}})`;
  }

  /** One pass over the text, so what * and ? produce is never translated again. */
  private static literal(text: string): string {
    return text.replace(/[.+^${}()|[\]\\*?/]/g, (c) => (c === "*" ? ".*?" : c === "?" ? "." : `\\${c}`));
  }

  private static wallClock(year: number, month: number, day: number, hour: number, minute: number, second: number): number | null {
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const d = new Date(ms);
    const real = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day && d.getUTCHours() === hour && d.getUTCMinutes() === minute && d.getUTCSeconds() === second;
    return real ? ms : null;
  }

  private static invalid(mask: string, message: string): PixError {
    return new PixError(ErrorCode.InvalidMessage, message, { mask });
  }
}

/** One account's list of formats. Formats with a time are tried first: they say more. */
export class FilenameFormats {
  /** The conventions Photo Date Fixer knew, as ordinary entries the user can delete. */
  static readonly DEFAULTS: readonly FilenameFormatEntry[] = [
    { mask: "PXL_yyyymmdd_hhmmss*.*", utc: true },
    { mask: "*yyyymmdd?hhmmss*.*", utc: false },
    { mask: "*yyyymmddhhmmss*.*", utc: false },
    { mask: "*yyyy-mm-dd?hh?mm?ss*.*", utc: false },
    { mask: "*yyyy-mm-dd at hh.mm.ss*.*", utc: false },
    { mask: "*yyyy-mm-dd-hhmmss*.*", utc: false },
    { mask: "*-yyyymmdd-WA*.*", utc: false },
    { mask: "yyyy-mm-dd*.*", utc: false },
  ];

  readonly #formats: FilenameFormat[];

  constructor(entries: readonly FilenameFormatEntry[]) {
    const formats = entries.map((e) => new FilenameFormat(e));
    this.#formats = [...formats.filter((f) => f.hasTime), ...formats.filter((f) => !f.hasTime)];
  }

  parse(fileName: string): FilenameStamp | null {
    for (const format of this.#formats) {
      const stamp = format.parse(fileName);
      if (stamp) return stamp;
    }
    return null;
  }
}
