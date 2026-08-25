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
}

export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** `length` is the only reason that authorises splitting a chunk. */
  finishReason: "stop" | "length" | "other";
}

export interface LlmBackend {
  call(input: LlmCall): Promise<LlmResult>;
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
