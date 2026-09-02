import type { ProjectStore, RunEvent, StoredTranslation, UnitFilter } from "../../core/ports.ts";
import type { TermEntry } from "../../core/glossary/types.ts";
import type { TranslationUnit, UnitState } from "../../core/epub/index.ts";
import type { CandidateReport } from "../../core/analyze/candidates.ts";
import type { CodeIndex } from "../../core/analyze/code.ts";
import type { MessagePortLike, StoreMethod, StoreRequest, StoreResponse } from "../shared/run.ts";
import { BabelError } from "../../core/errors.ts";

export type { MessagePortLike } from "../shared/run.ts";

class StoreRpcError extends BabelError {
  constructor(code: string) {
    // `defect`: the proxy to the main process failed, which is ours to fix and
    // never the reader's.
    super(code, { code, fault: "defect" });
    this.name = "StoreRpcError";
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * ProjectStore for the utility process.
 *
 * It contains no database import or file opening: every durable operation is
 * an RPC back to the main process, the one process that owns SQLite.
 */
export class StoreClient implements ProjectStore {
  #port: MessagePortLike;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;
  #onMessage: (event: { data: unknown }) => void;

  constructor(port: MessagePortLike) {
    this.#port = port;
    this.#onMessage = (event) => this.#receive(event.data);
    this.#port.on("message", this.#onMessage);
    this.#port.start?.();
  }

  async units(filter?: UnitFilter): Promise<TranslationUnit[]> {
    return this.#call("units", filter === undefined ? [] : [filter]) as Promise<TranslationUnit[]>;
  }

  async putUnitState(unitId: string, state: UnitState, reason?: string): Promise<void> {
    await this.#call("putUnitState", reason === undefined ? [unitId, state] : [unitId, state, reason]);
  }

  async translations(cacheKey: string): Promise<Map<string, StoredTranslation>> {
    return this.#call("translations", [cacheKey]) as Promise<Map<string, StoredTranslation>>;
  }

  async putTranslation(translation: StoredTranslation): Promise<void> {
    await this.#call("putTranslation", [translation]);
  }

  async terms(): Promise<TermEntry[]> {
    return this.#call("terms", []) as Promise<TermEntry[]>;
  }

  async putTerms(terms: TermEntry[]): Promise<void> {
    await this.#call("putTerms", [terms]);
  }

  async candidateReport(cacheKey: string): Promise<CandidateReport | null> {
    return this.#call("candidateReport", [cacheKey]) as Promise<CandidateReport | null>;
  }

  async putCandidateReport(cacheKey: string, report: CandidateReport): Promise<void> {
    await this.#call("putCandidateReport", [cacheKey, report]);
  }

  async codeIndex(sourceHash: string): Promise<CodeIndex | null> {
    return this.#call("codeIndex", [sourceHash]) as Promise<CodeIndex | null>;
  }

  async commitCodeIndex(index: CodeIndex): Promise<void> {
    await this.#call("commitCodeIndex", [index]);
  }

  async event(event: RunEvent): Promise<void> {
    await this.#call("event", [event]);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.off?.("message", this.#onMessage);
    this.#port.close?.();
    for (const { reject } of this.#pending.values()) reject(new StoreRpcError("STORE_DISCONNECTED"));
    this.#pending.clear();
  }

  #call(method: StoreMethod, args: unknown[]): Promise<unknown> {
    if (this.#closed) return Promise.reject(new StoreRpcError("STORE_DISCONNECTED"));

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        const request: StoreRequest = { type: "store", id, method, args };
        this.#port.postMessage(request);
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  #receive(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const response = message as Partial<StoreResponse>;
    if (response.type !== "store-result" || typeof response.id !== "number" || typeof response.ok !== "boolean") return;
    if (!response.ok && typeof (response as { code?: unknown }).code !== "string") return;

    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);

    if (response.ok) pending.resolve(response.value);
    else {
      const code = (response as { code?: unknown }).code;
      pending.reject(new StoreRpcError(typeof code === "string" ? code : "STORE_FAILED"));
    }
  }
}
