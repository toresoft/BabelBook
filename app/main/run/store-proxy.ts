import type { ProjectStore } from "../../../core/ports.ts";
import type { StoreMethod, StoreRequest, StoreResponse } from "../../shared/run.ts";

export interface StoreProxy {
  handle(request: StoreRequest): Promise<void>;
}

const METHODS: ReadonlySet<StoreMethod> = new Set([
  "units", "putUnitState", "translations", "putTranslation", "terms", "putTerms",
  "candidateReport", "putCandidateReport", "codeIndex", "commitCodeIndex", "event",
]);

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "STORE_FAILED";
}

/**
 * Exposes precisely the ProjectStore contract over the process boundary.
 *
 * This deliberately does not use `store[request.method]`: a process message
 * is untrusted input, and indexing an object would make its implementation
 * details (including `constructor`) remotely callable.
 */
export function makeStoreProxy(store: ProjectStore, send: (response: StoreResponse) => void): StoreProxy {
  const execute = async (method: StoreMethod, args: unknown[]): Promise<unknown> => {
    switch (method) {
      case "units": return store.units(args[0] as Parameters<ProjectStore["units"]>[0]);
      case "putUnitState": return store.putUnitState(
        args[0] as string,
        args[1] as Parameters<ProjectStore["putUnitState"]>[1],
        args[2] as Parameters<ProjectStore["putUnitState"]>[2],
      );
      case "translations": return store.translations(args[0] as string);
      case "putTranslation": return store.putTranslation(args[0] as Parameters<ProjectStore["putTranslation"]>[0]);
      case "terms": return store.terms();
      case "putTerms": return store.putTerms(args[0] as Parameters<ProjectStore["putTerms"]>[0]);
      case "candidateReport": return store.candidateReport(args[0] as string);
      case "putCandidateReport": return store.putCandidateReport(
        args[0] as string,
        args[1] as Parameters<ProjectStore["putCandidateReport"]>[1],
      );
      case "codeIndex": return store.codeIndex(args[0] as string);
      case "commitCodeIndex": return store.commitCodeIndex(
        args[0] as Parameters<ProjectStore["commitCodeIndex"]>[0],
      );
      case "event": return store.event(args[0] as Parameters<ProjectStore["event"]>[0]);
    }
  };

  return {
    async handle(request): Promise<void> {
      if (!METHODS.has(request.method as StoreMethod)) {
        send({ type: "store-result", id: request.id, ok: false, code: "UNKNOWN_METHOD" });
        return;
      }

      try {
        const value = await execute(request.method as StoreMethod, request.args);
        send({ type: "store-result", id: request.id, ok: true, value });
      } catch (error) {
        send({ type: "store-result", id: request.id, ok: false, code: failureCode(error) });
      }
    },
  };
}
