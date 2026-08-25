import { StoreClient } from "./store-client.ts";
import type {
  EngineCommand, EngineMessage, MessagePortLike, RunConfig,
} from "../shared/run.ts";

export interface EngineRunnerInput {
  projectId: string;
  config: RunConfig;
  store: StoreClient;
  emit(message: EngineMessage): void;
  signal: AbortSignal;
}

/** Task 6 provides the orchestration behind this narrow, process-safe seam. */
export type EngineRunner = (input: EngineRunnerInput) => Promise<void>;

function failureCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "ENGINE_FAILED";
}

function isRunConfig(config: unknown): config is RunConfig {
  if (typeof config !== "object" || config === null) return false;
  const value = config as Partial<RunConfig>;
  return typeof value.projectId === "string"
    && typeof value.cacheKey === "string"
    && typeof value.sourceLanguage === "string"
    && typeof value.targetLanguage === "string"
    && typeof value.autoAcceptTerms === "boolean"
    && typeof value.autoAcceptExclusions === "boolean"
    && typeof value.concurrency === "number";
}

function isEngineCommand(message: unknown): message is EngineCommand {
  if (typeof message !== "object" || message === null) return false;
  const command = message as Partial<EngineCommand>;
  if (command.type === "pause" || command.type === "cancel") return true;
  return command.type === "start"
    && typeof command.projectId === "string"
    && isRunConfig(command.config);
}

/** Installs the command loop without importing a database or an orchestrator. */
export function startEngineRuntime(port: MessagePortLike, runner?: EngineRunner): void {
  const store = new StoreClient(port);
  let controller: AbortController | undefined;

  port.on("message", (event) => {
    if (!isEngineCommand(event.data)) return;
    const command = event.data;
    if (command.type === "pause" || command.type === "cancel") {
      controller?.abort();
      return;
    }
    if (command.type !== "start") return;

    controller?.abort();
    controller = new AbortController();
    if (runner === undefined) {
      port.postMessage({ type: "failed", code: "RUNNER_UNAVAILABLE" } satisfies EngineMessage);
      return;
    }

    const signal = controller.signal;
    void runner({
      projectId: command.projectId,
      config: command.config,
      store,
      emit: (message) => port.postMessage(message),
      signal,
    }).catch((error) => {
      if (!signal.aborted) port.postMessage({ type: "failed", code: failureCode(error) } satisfies EngineMessage);
    });
  });
  port.start?.();
}

const parentPort = process.parentPort as typeof process.parentPort | undefined;
if (parentPort !== null && parentPort !== undefined) {
  parentPort.on("message", (event) => {
    const port = event.ports[0] as MessagePortLike | undefined;
    if (port === undefined) {
      parentPort.postMessage({ type: "failed", code: "ENGINE_PORT_MISSING" } satisfies EngineMessage);
      return;
    }
    startEngineRuntime(port);
  });
}
