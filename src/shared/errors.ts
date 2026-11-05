/**
 * Pixlixir error model.
 *
 * Every failure carries a stable machine-readable code, a human message and
 * optional structured context. We never swallow errors or silently fall back:
 * callers either handle a specific code or let it propagate to the UI.
 */

export const ErrorCode = {
  // Session / account
  SessionUnavailable: "SESSION_UNAVAILABLE",
  AccountMismatch: "ACCOUNT_MISMATCH",
  TabNotBound: "TAB_NOT_BOUND",

  // Private Google Photos protocol
  RpcHttpError: "RPC_HTTP_ERROR",
  RpcEnvelopeMissing: "RPC_ENVELOPE_MISSING",
  RpcUnexpectedShape: "RPC_UNEXPECTED_SHAPE",
  UploadFailed: "UPLOAD_FAILED",

  // Media
  MediaFetchFailed: "MEDIA_FETCH_FAILED",
  MediaDecodeFailed: "MEDIA_DECODE_FAILED",

  // Messaging / validation
  InvalidMessage: "INVALID_MESSAGE",
  UntrustedSender: "UNTRUSTED_SENDER",
  NoHandler: "NO_HANDLER",

  // Imaging
  InvalidGeometry: "INVALID_GEOMETRY",
  InvalidImage: "INVALID_IMAGE",

  // Panorama
  StitchNotConnected: "STITCH_NOT_CONNECTED",
  StitchFailed: "STITCH_FAILED",
  OutOfMemory: "OUT_OF_MEMORY",
  RuntimeUnavailable: "RUNTIME_UNAVAILABLE",

  // Jobs / storage
  JobNotFound: "JOB_NOT_FOUND",
  StorageFailed: "STORAGE_FAILED",

  // Dates
  DateNotApplied: "DATE_NOT_APPLIED",

  // Generic
  Cancelled: "CANCELLED",
  Internal: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Serializable error shape used across extension message boundaries. */
export interface SerializedError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export class PixError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PixError";
    this.code = code;
    this.details = details;
  }

  toJSON(): SerializedError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  /** Rehydrate an error that crossed a message boundary. */
  static fromSerialized(e: SerializedError): PixError {
    return new PixError(e.code, e.message, e.details);
  }

  /** Wrap an unknown thrown value, preserving PixErrors as-is. */
  static wrap(err: unknown, code: ErrorCode, message: string, details?: Record<string, unknown>): PixError {
    if (err instanceof PixError) return err;
    const causeText = err instanceof Error ? err.message : String(err);
    return new PixError(code, `${message}: ${causeText}`, details, { cause: err });
  }
}
