/**
 * What went wrong, and what that authorises.
 *
 * The core never produces a sentence for a reader: an error carries a stable
 * `code` and the interface composes the wording from it, in its own language.
 * The `fault` is the second half of that idea. It does not describe the
 * failure — it answers the only question a caller actually has, which is what
 * to do next, and it answers it the same way every time.
 */
export type Fault =
  /** Retrying helps, and at once: a socket closed, a timeout, a 5xx. */
  | "transient"
  /** Retrying helps, but at the hour the provider named. */
  | "throttled"
  /** Retrying today does not help: the credit or the daily quota is gone. */
  | "exhausted"
  /** Somebody has to change a setting before this can work at all. */
  | "config"
  /** The book itself: undecodable, malformed, not an EPUB. */
  | "input"
  /** The gate refused what we composed. Composing it again unchanged would not help. */
  | "refused"
  /** An invariant of ours broke. This is what the diagnostic file is for. */
  | "defect"
  /** A pause or a cancellation. Not a failure, but it travels the same `catch`. */
  | "cancelled";

/**
 * The two tables, and the only two readings of a fault that are allowed.
 *
 * An `if` on the fault written anywhere else is a second table, and it is the
 * second table that drifts. Both are exhaustive by their type: a fault added
 * without an answer here stops compiling, which is the point.
 */
export const RETRIES_ON: Record<Fault, boolean> = {
  transient: true,
  throttled: true,
  exhausted: false,
  config: false,
  input: false,
  refused: false,
  defect: false,
  cancelled: false,
};

/** True where the project stops in `paused`, false where it stops in `failed`. */
export const PAUSES_ON: Record<Fault, boolean> = {
  transient: true,
  throttled: true,
  exhausted: true,
  config: true,
  input: false,
  refused: false,
  defect: false,
  cancelled: true,
};

const FAULTS = new Set<string>(Object.keys(RETRIES_ON));

export interface BabelErrorInit {
  code: string;
  fault: Fault;
  /**
   * An allow-list, never the raw error.
   *
   * A provider's error object holds the request that caused it, headers
   * included, which is to say the API key. Copying one wholesale into a detail
   * or a log line is exactly how the promise that the key never leaves the
   * main process breaks without anybody noticing. Whoever classifies names the
   * fields it wants and drops the rest.
   */
  detail?: Record<string, string | number | boolean>;
  /** Only on `throttled`, and only when the provider actually said so. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class BabelError extends Error {
  readonly code: string;
  readonly fault: Fault;
  readonly detail: Record<string, string | number | boolean>;
  readonly retryAfterMs?: number;

  constructor(message: string, init: BabelErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "BabelError";
    this.code = init.code;
    this.fault = init.fault;
    this.detail = init.detail ?? {};
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }
}

/**
 * Recognised by shape, not by prototype.
 *
 * The engine runs in its own process: what arrives on the other side of the
 * port was structurally cloned, and `instanceof` there is always false.
 */
export function isBabelError(error: unknown): error is BabelError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; fault?: unknown };
  return typeof candidate.code === "string"
    && typeof candidate.fault === "string"
    && FAULTS.has(candidate.fault);
}

/**
 * The EPUB layer's own errors, kept as names because they read well at the
 * throw site. They are `BabelError`s now, and they are all `input`: a book
 * that will not open does not open on the second attempt either.
 */
export class EpubError extends BabelError {
  constructor(message: string, code: string, fault: Fault = "input") {
    super(message, { code, fault });
    this.name = new.target.name;
  }
}

export class EpubReadError extends EpubError {}
export class EpubWriteError extends EpubError {}
export class ScanError extends EpubError {}
