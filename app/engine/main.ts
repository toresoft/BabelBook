import { StoreClient } from "./store-client.ts";
import { generateObject, generateText } from "ai";
import type { LlmBackend, ProjectStore } from "../../core/ports.ts";
import { runProject } from "../main/run/orchestrator.ts";
import { resolveModel } from "./backends/resolve.ts";
import { sdkBackend } from "./backends/sdk.ts";
import { fakeBackend } from "./fake.ts";
import type {
  BackendSpec, EngineCommand, EngineMessage, MessagePortLike, RunConfig,
} from "../shared/run.ts";

export interface EngineRunnerInput {
  projectId: string;
  config: RunConfig;
  backendSpec: BackendSpec;
  machineSnapshot?: unknown;
  store: ProjectStore;
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

function isBackendSpec(spec: unknown): spec is BackendSpec {
  if (typeof spec !== "object" || spec === null) return false;
  const candidate = spec as Partial<BackendSpec>;
  if (candidate.kind === "fake") return true;
  return candidate.kind === "sdk"
    && typeof candidate.spec === "string"
    && (candidate.apiKey === null || typeof candidate.apiKey === "string")
    && (candidate.baseUrl === null || typeof candidate.baseUrl === "string")
    && typeof candidate.headers === "object" && candidate.headers !== null
    && typeof candidate.options === "object" && candidate.options !== null
    && (candidate.name === null || candidate.name === undefined
      || typeof candidate.name === "string")
    && (candidate.structured === undefined || typeof candidate.structured === "boolean");
}

function isEngineCommand(message: unknown): message is EngineCommand {
  if (typeof message !== "object" || message === null) return false;
  const command = message as Partial<EngineCommand>;
  if (command.type === "pause" || command.type === "cancel") return true;
  return command.type === "start"
    && typeof command.projectId === "string"
    && isRunConfig(command.config)
    && isBackendSpec(command.backend);
}

/**
 * A backend, built here because behaviour cannot cross the process boundary.
 *
 * Provider code is selected by the registry and loaded only for SDK runs; the
 * SDK itself is a production dependency and can keep its type at this seam.
 */
async function backendFromSpec(spec: BackendSpec): Promise<LlmBackend> {
  if (spec.kind === "fake") return fakeBackend();

  const resolved = await resolveModel(spec.spec, {
    apiKey: spec.apiKey,
    baseUrl: spec.baseUrl,
    ...(spec.name === null || spec.name === undefined ? {} : { name: spec.name }),
    ...(spec.structured === undefined ? {} : { structured: spec.structured }),
    ...(Object.keys(spec.headers).length === 0 ? {} : { headers: spec.headers }),
    options: spec.options,
  });
  // `generateObject` is generic over its schema, and the adapter's port is
  // not: the cast lives here, at the one call, rather than widening the port.
  return sdkBackend(resolved, generateText, (input) => generateObject(input as never));
}

/** The production runner: a backend from the spec, then the phases. */
const productionRunner: EngineRunner = async (input) => {
  const backend = await backendFromSpec(input.backendSpec);
  const summary = await runProject({
    store: input.store,
    backend,
    config: input.config,
    ...(input.machineSnapshot === undefined ? {} : { machineSnapshot: input.machineSnapshot }),
    emit: input.emit,
    signal: input.signal,
  });

  // The engine's last word, and the only place the token counts exist. It says
  // the engine is finished, not that the book is: composition belongs to the
  // main process, and the reader is told once the file is on disk.
  input.emit({ type: "done", summary });
};

/**
 * Installs the command loop without importing a database. The runner is
 * injected: tests pass their own, and the production entry registers one that
 * resolves the backend from the spec each start command carries.
 */
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
      backendSpec: command.backend,
      ...(command.machineSnapshot === undefined ? {} : { machineSnapshot: command.machineSnapshot }),
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
    startEngineRuntime(port, productionRunner);
  });
}
