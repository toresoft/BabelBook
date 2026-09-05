/**
 * The vocabulary of the main/engine process boundary.
 *
 * These are plain, dependency-free values on purpose. The engine must not
 * import the main process (where SQLite lives), and the main process must not
 * import engine implementation just to understand a message.
 */

import type { Fault } from "../../core/errors.ts";
import type { RunPhase } from "./dto.ts";

export type { RunPhase } from "./dto.ts";

/**
 * Materials for the engine to build its backend from.
 *
 * A backend is behaviour and cannot cross a process boundary; what crosses is
 * the plain data to build one. The API key travels on this dedicated port and
 * no other — it never reaches the renderer, not even masked.
 */
export type BackendSpec =
  /** the deterministic backend of the whole-application test */
  | { kind: "fake" }
  | {
    kind: "sdk";
    /** `route:model-id`, as the resolver reads it */
    spec: string;
    apiKey: string | null;
    baseUrl: string | null;
    headers: Record<string, string>;
    options: Record<string, unknown>;
    /**
     * Who answers at that endpoint, and so the key the options are read
     * under. Null when the route is a package: a package is its own name.
     */
    name: string | null;
    /**
     * Whether the answer's shape can be imposed rather than asked for in
     * words. It decides which of the two contracts the run translates under,
     * so it is part of the cache key as well.
     */
    structured: boolean;
  };

export interface RunConfig {
  projectId: string;
  cacheKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  autoAcceptTerms: boolean;
  autoAcceptExclusions: boolean;
  concurrency: number;
  /** The model's context window in tokens, when known; it can only shrink chunks. */
  contextWindowTokens?: number | null;
}

export interface RunSummary {
  units: { total: number; translated: number; fellBack: number; identical: number };
  notTranslated: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  /** Part of `tokensOut`, not on top of it: what was spent thinking. */
  reasoningTokens: number;
}

export type EngineCommand =
  | {
    type: "start";
    projectId: string;
    /** The run the engine's diagnostic file is named after. */
    runId: string;
    /** Where the run's workspace — and so its `logs/` directory — lives. */
    workspaceRoot: string;
    config: RunConfig;
    backend: BackendSpec;
    machineSnapshot?: unknown;
  }
  | { type: "pause" }
  | { type: "cancel" };

/** Accepted engine-side phase events that the main-owned machine persists. */
export type RunTransition = "TERMS_READY" | "CODE_INDEXED" | "TRANSLATED" | "COMPOSED";

export type StoreMethod =
  | "units"
  | "putUnitState"
  | "translations"
  | "putTranslation"
  | "terms"
  | "putTerms"
  | "candidateReport"
  | "putCandidateReport"
  | "codeIndex"
  | "commitCodeIndex"
  | "event";

export interface StoreRequest {
  type: "store";
  id: number;
  method: StoreMethod | string;
  args: unknown[];
}

export type StoreResponse =
  | { type: "store-result"; id: number; ok: true; value: unknown }
  | { type: "store-result"; id: number; ok: false; code: string };

export type EngineMessage =
  | { type: "phase"; phase: string }
  | { type: "progress"; phase: RunPhase; done: number; total: number }
  | { type: "usage"; tokensIn: number; tokensOut: number; reasoningTokens: number }
  /**
   * A capability the catalogue claimed and the endpoint denied.
   *
   * The engine learns it and cannot keep it: the claim lives on a row in a
   * database this process does not reach. So it is sent, once, to the side
   * that owns the row — and the next run never pays the refused call again.
   */
  | { type: "capability"; name: "structuredOutput"; supported: false }
  | { type: "gate"; gate: "terms" | "code" }
  | { type: "transition"; event: RunTransition }
  | { type: "done"; summary: RunSummary }
  | {
    type: "failed";
    code: string;
    /** What the main process reads to choose between `paused` and `failed`. */
    fault: Fault;
    detail?: Record<string, string | number | boolean>;
    retryAfterMs?: number;
  }
  | StoreRequest;

/** The tiny common denominator shared by Electron's two MessagePort variants. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  off?(event: "message", listener: (event: { data: unknown }) => void): unknown;
  start?(): void;
  close?(): void;
}

export interface EngineHandle {
  send(command: EngineCommand): void;
  on(listener: (message: EngineMessage) => void): () => void;
  kill(): Promise<void>;
  readonly alive: boolean;
}
