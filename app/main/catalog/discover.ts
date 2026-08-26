import { classifyError } from "../providers/verify.ts";

/**
 * What an endpoint says it serves, asked the one way almost everybody answers:
 * `GET /v1/models`, the OpenAI-compatible convention. Ollama, LM Studio and
 * 163 of the 203 providers in the catalogue all speak it.
 */

/** A model id as the endpoint itself declared it. */
export interface Discovered {
  id: string;
  source: "endpoint";
}

/**
 * The codes discovery fails with, in the vocabulary the interface already
 * speaks for providers. `bad-response` is the one that is new here, and it is
 * load-bearing: "the endpoint serves no models" and "the answer was not a
 * model list" must never share a sentence, because one is a fact to show and
 * the other is a defect to report.
 */
export type DiscoverCode = "unauthorized" | "unreachable" | "bad-response";

/** Thrown with a code, never with the provider's words. */
export class DiscoverError extends Error {
  readonly code: DiscoverCode;

  constructor(code: DiscoverCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "DiscoverError";
    this.code = code;
  }
}

export interface DiscoverInput {
  baseUrl: string;
  apiKey: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** The wait has a limit: a wrong port must not freeze the screen forever. */
  timeoutMs?: number;
}

/** Long enough for a cold local server to list its models, short enough for a dialog. */
const DEFAULT_TIMEOUT_MS = 10_000;

function codeForStatus(status: number): DiscoverCode {
  if (status === 401 || status === 403) return "unauthorized";
  // A server that is broken is a service that was not reached; anything else
  // answered, but not with a model list.
  if (status >= 500) return "unreachable";
  return "bad-response";
}

/**
 * Asks the endpoint what it serves.
 *
 * The list comes from the endpoint, not the catalogue, by construction: only
 * the server in front of you knows which models your key — or your laptop —
 * can actually reach. What the catalogue adds later is the metadata the
 * endpoint cannot say: prices, windows, capabilities.
 */
export async function discoverModels(input: DiscoverInput): Promise<Discovered[]> {
  const base = input.baseUrl.trim().replace(/\/+$/, "");
  if (base === "") {
    throw new DiscoverError("bad-response", "the base URL is empty");
  }

  const headers: Record<string, string> = { ...input.headers };
  if (input.apiKey !== null && input.apiKey !== "") {
    headers["authorization"] = `Bearer ${input.apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.any([
        ...(input.signal !== undefined ? [input.signal] : []),
        AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ]),
    });
  } catch (error) {
    // Nothing answered at all. The provider's own words, when there are any,
    // stop here: they are English, unstable, and sometimes quote the key.
    const classified = classifyError(error);
    throw new DiscoverError(
      classified === "unauthorized" ? "unauthorized" : "unreachable",
      `the endpoint did not answer (${classified})`,
    );
  }

  if (!response.ok) {
    throw new DiscoverError(codeForStatus(response.status),
      `the endpoint answered ${response.status}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new DiscoverError("bad-response", "the answer is not JSON");
  }

  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new DiscoverError("bad-response", "the answer has no model list");
  }

  const models: Discovered[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id === "string" && id !== "") models.push({ id, source: "endpoint" });
  }
  // Entries that cannot be named are skipped; a list of which nothing could be
  // named is not "this endpoint serves nothing" but "this answer was not a
  // model list", and the two must not share a screen sentence.
  if (data.length > 0 && models.length === 0) {
    throw new DiscoverError("bad-response", "the model list names no models");
  }
  return models;
}
