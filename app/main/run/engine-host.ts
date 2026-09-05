import { createRequire } from "node:module";
import { join } from "node:path";
import type { ProjectStore } from "../../../core/ports.ts";
import { makeStoreProxy, type StoreProxy } from "./store-proxy.ts";
import type {
  EngineCommand, EngineHandle, EngineMessage, MessagePortLike, StoreRequest,
} from "../../shared/run.ts";
import { RUN_PHASES, type RunPhase } from "../../shared/dto.ts";
import type { MessagePortMain } from "electron";

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

const require = createRequire(import.meta.url);

function isRecord(message: unknown): message is Record<string, unknown> {
  return typeof message === "object" && message !== null;
}

function isStoreRequest(message: unknown): message is StoreRequest {
  if (!isRecord(message)) return false;
  const candidate = message as Partial<StoreRequest>;
  return candidate.type === "store"
    && typeof candidate.id === "number"
    && typeof candidate.method === "string"
    && Array.isArray(candidate.args);
}

export function isEngineMessage(message: unknown): message is Exclude<EngineMessage, StoreRequest> {
  if (!isRecord(message)) return false;
  switch (message.type) {
    case "phase": return typeof message.phase === "string";
    case "progress":
      return typeof message.done === "number" && typeof message.total === "number"
        && RUN_PHASES.includes(message.phase as RunPhase);
    case "usage":
      return typeof message.tokensIn === "number" && typeof message.tokensOut === "number"
        && typeof message.reasoningTokens === "number";
    case "gate": return message.gate === "terms" || message.gate === "code";
    case "transition": return message.event === "TERMS_READY"
      || message.event === "CODE_INDEXED"
      || message.event === "TRANSLATED"
      || message.event === "COMPOSED";
    // Narrow on purpose: this is a denial, never a claim. A message that could
    // turn a capability *on* would let the engine talk the application into
    // asking for something no endpoint ever agreed to.
    case "capability":
      return message.name === "structuredOutput" && message.supported === false;
    case "done": return isRecord(message.summary);
    case "failed": return typeof message.code === "string";
    default: return false;
  }
}

interface ElectronRuntime {
  utilityProcess: typeof import("electron").utilityProcess;
  MessageChannelMain: typeof import("electron").MessageChannelMain;
}

function electronDeps(): Pick<EngineHostDeps, "enginePath" | "fork" | "makeChannel"> {
  const electron = require("electron") as ElectronRuntime;
  return {
    // The bundle flattens the source tree: this file lands in dist/main, next
    // to dist/engine — one level up, not the two the source layout suggests.
    enginePath: join(import.meta.dirname, "..", "engine", "main.js"),
    fork: (path) => {
      const child = electron.utilityProcess.fork(path);
      return {
        postMessage: (message, ports) => child.postMessage(message, ports as unknown as MessagePortMain[]),
        kill: () => child.kill(),
        on: (event, listener) => child.on(event, listener),
        off: (event, listener) => child.off(event, listener),
      };
    },
    makeChannel: () => {
      const channel = new electron.MessageChannelMain();
      return {
        port1: channel.port1 as unknown as MessagePortLike,
        port2: channel.port2 as unknown as MessagePortLike,
      };
    },
  };
}

let productionConfig: Partial<EngineHostDeps> = {};

/**
 * Registers main-owned persistence for the zero-argument production entry.
 *
 * Task 6/8 supplies the actual project store and paused/event transaction. A
 * no-op crash handler is safer than guessing a run id before that wiring is
 * available, while the configured handler remains the only place that writes
 * lifecycle state.
 */
export function configureEngineHost(config: Partial<EngineHostDeps>): () => void {
  const previous = productionConfig;
  productionConfig = { ...productionConfig, ...config };
  return () => { productionConfig = previous; };
}

function productionDeps(): EngineHostDeps {
  const defaults = electronDeps();
  return {
    ...defaults,
    ...productionConfig,
    storeFor: productionConfig.storeFor ?? (() => {
      throw new Error("ENGINE_HOST_NOT_CONFIGURED");
    }),
    onCrash: productionConfig.onCrash ?? (async () => {}),
  };
}

/**
 * Starts one utility process and makes its dedicated MessagePort the sole
 * channel for run commands, events and ProjectStore RPC.
 */
export function makeEngineHost(deps: EngineHostDeps): EngineHandle {
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

    if (!isEngineMessage(message)) return;
    for (const listener of listeners) listener(message);
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

/** Starts the real Electron utility process through the production boundary. */
export function startEngine(): EngineHandle {
  return makeEngineHost(productionDeps());
}
