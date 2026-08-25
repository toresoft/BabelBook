/**
 * The vocabulary of the main/engine process boundary.
 *
 * These are plain, dependency-free values on purpose. The engine must not
 * import the main process (where SQLite lives), and the main process must not
 * import engine implementation just to understand a message.
 */

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
  };

export interface RunConfig {
  projectId: string;
  cacheKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  autoAcceptTerms: boolean;
  autoAcceptExclusions: boolean;
  concurrency: number;
}

export interface RunSummary {
  units: { total: number; translated: number; fellBack: number; identical: number };
  notTranslated: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
}

export type EngineCommand =
  | {
    type: "start";
    projectId: string;
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
  | { type: "progress"; done: number; total: number }
  | { type: "gate"; gate: "terms" | "code" }
  | { type: "transition"; event: RunTransition }
  | { type: "done"; summary: RunSummary }
  | { type: "failed"; code: string }
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
