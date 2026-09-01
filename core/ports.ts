/**
 * What the engine needs from whoever hosts it.
 *
 * The core opens no file of its own and knows nothing about a window or a
 * database: it declares these interfaces and receives implementations. That is
 * what keeps every phase testable in memory, and what stops the host's
 * concerns from leaking into the model-facing code.
 */

import type { TranslationUnit, UnitState } from "./epub/index.ts";
import type { TermEntry } from "./glossary/types.ts";
import type { CandidateReport } from "./analyze/candidates.ts";
import type { CodeIndex } from "./analyze/code.ts";

export interface StoredTranslation {
  unitId: string;
  text: string;
  cacheKey: string;
  attempts: number;
  /** `identical` is a success whose text equals the source: counted, not hidden. */
  outcome: "translated" | "fell-back" | "identical";
}

/**
 * Something worth declaring about a run.
 *
 * `code` is stable and machine-readable; the sentence belongs to the
 * interface's catalogue. `degradation` is what raises a run to incomplete —
 * an author's own `translate="no"` is `info`, because honouring it is correct
 * behaviour rather than a loss.
 */
export interface RunEvent {
  code: string;
  severity: "info" | "warning" | "degradation";
  payload: Record<string, unknown>;
}

export interface UnitFilter {
  states?: UnitState[];
  doc?: string;
}

export interface ProjectStore {
  units(filter?: UnitFilter): Promise<TranslationUnit[]>;
  putUnitState(unitId: string, state: UnitState, reason?: string): Promise<void>;
  translations(cacheKey: string): Promise<Map<string, StoredTranslation>>;
  putTranslation(translation: StoredTranslation): Promise<void>;
  terms(): Promise<TermEntry[]>;
  putTerms(terms: TermEntry[]): Promise<void>;
  candidateReport(cacheKey: string): Promise<CandidateReport | null>;
  putCandidateReport(cacheKey: string, report: CandidateReport): Promise<void>;
  codeIndex(sourceHash: string): Promise<CodeIndex | null>;
  /** Atomically applies unit decisions, stores the checkpoint, and declares abstention. */
  commitCodeIndex(index: CodeIndex): Promise<void>;
  event(event: RunEvent): Promise<void>;
}

export interface LlmCall {
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * A JSON Schema the answer must conform to, for a backend that can impose
   * one. Plain data on purpose: the core names no SDK and no validation
   * library, and a schema is an object either way.
   */
  schema?: Record<string, unknown>;
}

export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /**
   * The share of `tokensOut` the model spent thinking rather than answering.
   *
   * Counted apart because it is the one number that explains an empty answer
   * from a model that was paid in full: a reasoning model given no output
   * budget of its own can spend all of it before the format begins, and
   * without this the run records only that nothing came back.
   */
  reasoningTokens: number;
  /** `length` is the only reason that authorises splitting a chunk. */
  finishReason: "stop" | "length" | "other";
}

export interface LlmBackend {
  call(input: LlmCall): Promise<LlmResult>;
  /**
   * Whether a `schema` is enforced rather than ignored.
   *
   * Absent means no: a backend that cannot impose a shape must be asked for
   * one in words, and a caller that assumed otherwise would send instructions
   * with no format in them and get prose back.
   */
  readonly structured?: boolean;
}

export interface Progress {
  phase: "analyze" | "candidates" | "code-index" | "translate" | "compose";
  done: number;
  total: number;
  unitId?: string;
}

export interface ProgressSink {
  report(progress: Progress): void;
}

/**
 * How loud a line is, and by consequence where it goes.
 *
 * One axis, not two. `debug` goes to the diagnostic file only; `info`, `warn`
 * and `error` go there and to the reader's log as well. A second field saying
 * "this one is public" would be the same decision written twice.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Something that happened, in the same stable vocabulary as `RunEvent`.
 *
 * `code` is machine-readable and the interface composes the sentence from it,
 * in its own language — the rule the whole core follows. `detail` is scalars
 * only, and is an allow-list for the same reason `BabelError.detail` is: a
 * provider's error holds the request it failed on, key included.
 */
export interface LogRecord {
  level: LogLevel;
  code: string;
  detail?: Record<string, string | number | boolean>;
}

/**
 * The narrative of a run, beside `ProjectStore.event`, which is its verdicts.
 *
 * They are not the same thing and are deliberately not merged: a `degradation`
 * lowers a book to `incomplete` and belongs to the report; a log line says
 * what happened and belongs to the story. Both end up in `run_event`, and the
 * severity column tells them apart.
 */
export interface LogSink {
  record(entry: LogRecord): void;
}

/**
 * The default every phase gets when nobody wired one.
 *
 * Silent and total on purpose: a sink is an observation, and an observation
 * that can fail a run is worse than no observation.
 */
export const nullSink: LogSink = { record: () => {} };
