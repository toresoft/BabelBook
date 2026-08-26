import type { LocalRuntime } from "../../shared/dto.ts";
import { discoverModels } from "./discover.ts";

/**
 * The runtimes that serve models from the user's own machine.
 *
 * Neither is in the catalogue for this purpose — the catalogue cannot know
 * which models were pulled on this laptop — so the only honest source is the
 * running server. Both answer the same `GET /v1/models`, which is why one
 * probe covers both.
 */

/** The ports each runtime listens on by default. */
export const DEFAULT_PORTS = { ollama: 11434, lmstudio: 1234 } as const;

/**
 * Ollama wants a key in the header and ignores its value; LM Studio wants
 * none. Documented, and the difference between the two rows of configuration.
 */
const RUNTIMES = [
  { id: "ollama", name: "Ollama", port: DEFAULT_PORTS.ollama, apiKey: "ollama" },
  { id: "lmstudio", name: "LM Studio", port: DEFAULT_PORTS.lmstudio, apiKey: null },
] as const;

export interface ProbeOptions {
  /** Whoever changed a port gets to say so. */
  ports?: { ollama?: number; lmstudio?: number };
  signal?: AbortSignal;
  /**
   * The wait is short by default because the probe runs while the user is
   * looking at a list: a machine with nothing running must not feel slow.
   */
  timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 1_500;

/**
 * Asks both runtimes what they serve, and answers with those that did.
 *
 * A runtime that is not running is not an error and not a warning: it is
 * simply absent from the answer, the same way a book not yet opened is.
 */
export async function probeLocalRuntimes(options: ProbeOptions = {}): Promise<LocalRuntime[]> {
  const found = await Promise.all(RUNTIMES.map(async (runtime): Promise<LocalRuntime | null> => {
    const baseUrl = `http://127.0.0.1:${options.ports?.[runtime.id] ?? runtime.port}/v1`;
    try {
      const models = await discoverModels({
        baseUrl,
        apiKey: runtime.apiKey,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      });
      return {
        id: runtime.id,
        name: runtime.name,
        baseUrl,
        apiKey: runtime.apiKey,
        models: models.map((model) => model.id),
      };
    } catch {
      // Nothing answered on that port, or what answered was not a model list:
      // either way this runtime is not available, and the rest still are.
      return null;
    }
  }));

  return found.filter((runtime): runtime is LocalRuntime => runtime !== null);
}
