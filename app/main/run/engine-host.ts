import type { ProjectStore } from "../../../core/ports.ts";
import { makeStoreProxy, type StoreProxy } from "./store-proxy.ts";
import type {
  EngineCommand, EngineHandle, EngineMessage, MessagePortLike, StoreRequest,
} from "../../shared/run.ts";

export type { EngineHandle } from "../../shared/run.ts";

export interface UtilityProcessLike {
  postMessage(message: unknown, ports: MessagePortLike[]): void;
  kill(): boolean;
  on(event: "exit", listener: (code: number) => void): unknown;
  off?(event: "exit", listener: (code: number) => void): unknown;
}

export interface EngineHostDeps {
  enginePath: string;
  fork(path: string): UtilityProcessLike;
  makeChannel(): { port1: MessagePortLike; port2: MessagePortLike };
  storeFor(projectId: string): ProjectStore;
  /** Persists the paused state and its run event after an unexpected exit. */
  onCrash(projectId: string): Promise<void>;
}

function isStoreRequest(message: unknown): message is StoreRequest {
  const candidate = message as Partial<StoreRequest>;
  return candidate.type === "store"
    && typeof candidate.id === "number"
    && typeof candidate.method === "string"
    && Array.isArray(candidate.args);
}

/**
 * Starts one utility process and makes its dedicated MessagePort the sole
 * channel for run commands, events and ProjectStore RPC.
 */
export function startEngine(deps: EngineHostDeps): EngineHandle {
  const child = deps.fork(deps.enginePath);
  const channel = deps.makeChannel();
  const port = channel.port1;
  const listeners = new Set<(message: EngineMessage) => void>();
  let activeProject: string | undefined;
  let proxy: StoreProxy | undefined;
  let alive = true;
  let deliberatelyKilled = false;

  const exit = (): void => {
    if (!alive) return;
    alive = false;
    port.close?.();
    if (!deliberatelyKilled && activeProject !== undefined) {
      void deps.onCrash(activeProject).catch(() => {});
    }
  };

  child.on("exit", exit);
  port.on("message", (event) => {
    const message = event.data;
    if (isStoreRequest(message)) {
      if (proxy === undefined) {
        port.postMessage({ type: "store-result", id: message.id, ok: false, code: "NO_ACTIVE_PROJECT" });
      } else {
        void proxy.handle(message);
      }
      return;
    }

    const eventMessage = message as EngineMessage;
    if (eventMessage.type === "phase" || eventMessage.type === "progress" || eventMessage.type === "gate"
      || eventMessage.type === "done" || eventMessage.type === "failed") {
      for (const listener of listeners) listener(eventMessage);
    }
  });
  port.start?.();
  child.postMessage({ type: "connect" }, [channel.port2]);

  return {
    send(command: EngineCommand): void {
      if (!alive) throw new Error("ENGINE_DEAD");
      if (command.type === "start") {
        activeProject = command.projectId;
        proxy = makeStoreProxy(deps.storeFor(command.projectId), (response) => port.postMessage(response));
      }
      port.postMessage(command);
    },

    on(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async kill(): Promise<void> {
      if (!alive) return;
      deliberatelyKilled = true;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          child.off?.("exit", done);
          resolve();
        };
        child.on("exit", done);
        if (!child.kill()) done();
      });
    },

    get alive(): boolean {
      return alive;
    },
  };
}
