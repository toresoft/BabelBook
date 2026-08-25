/**
 * The vocabulary of the main/engine process boundary.
 *
 * These are plain, dependency-free values on purpose. The engine must not
 * import the main process (where SQLite lives), and the main process must not
 * import engine implementation just to understand a message.
 */

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
  | { type: "start"; projectId: string; config: RunConfig }
  | { type: "pause" }
  | { type: "cancel" };

export type StoreMethod =
  | "units"
  | "putUnitState"
  | "translations"
  | "putTranslation"
  | "terms"
  | "putTerms"
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
