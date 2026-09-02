/**
 * From a written model spec to something the AI SDK can call.
 *
 * The whole point of this file is that it runs *before* the book is opened.
 * A missing package, an absent key or a malformed spec must surface at the
 * start of a run, not at the first chunk — by then analysis has already been
 * paid for, and the user is looking at a progress bar that will never finish.
 */

import { GENERIC_ROUTE, PROVIDER_PACKAGES, type ProviderPackages } from "./registry.ts";
import { BabelError } from "../../../core/errors.ts";

/**
 * A spec that cannot become a model, with a code the interface can translate.
 *
 * `spec` travels with the error because a run names one model and the message
 * shown to the user has to say which one; the code is what the catalogue keys
 * off, never the sentence.
 */
export class ModelSpecError extends BabelError {
  readonly spec: string;

  constructor(code: string, spec: string, message: string) {
    // `config`: the route or the model named in the settings is not one this
    // build can resolve, and only the settings can fix that.
    super(`${code}: ${message}`, { code, fault: "config", detail: { spec } });
    this.name = "ModelSpecError";
    this.spec = spec;
  }
}

/** What a resolved spec is: the model object, its identity, and its options. */
export interface ResolvedModel {
  /** The SDK's `LanguageModel`. Opaque here — only `generateText` reads it. */
  model: unknown;
  /** The spec as written, `route:id`. It goes into the cache key verbatim. */
  modelId: string;
  /** `providerOptions` for the call, keyed by provider as the SDK expects. */
  options?: Record<string, unknown>;
  /** Whether the catalogue says this model can be held to a schema. */
  structured?: boolean;
}

export interface ResolveDeps {
  /**
   * The packages this application ships, injected so a test can name its own.
   * Absent means the real registry, which is what production wants.
   */
  packages?: ProviderPackages;
  apiKey: string | null;
  baseUrl: string | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
  /** Whether the catalogue says this model can be held to a schema. */
  structured?: boolean;
  /**
   * Who is answering, for the one route that cannot know.
   *
   * The generic route is a protocol: without a name the SDK keys the call's
   * options under `undefined`, and every option written for the provider
   * behind the endpoint is read by nobody. A route that is a package has its
   * own name and is given none.
   */
  name?: string;
}

/**
 * A route becomes half of an import specifier, so it is validated first.
 *
 * Without this, a route read from the database is an arbitrary import: a value
 * of `../../something` is a path, not a package name, and would be loaded as
 * one.
 */
const ROUTE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Splits `route:id` at the **first** colon, never the last.
 *
 * Model ids carry colons of their own — a Bedrock ARN ends in `:0` — so
 * cutting at the end would hand the factory half an id and the failure would
 * arrive from the provider, in the provider's words, one call later.
 */
export function parseSpec(spec: string): { route: string; id: string } {
  const cut = spec.indexOf(":");
  if (cut < 0) {
    throw new ModelSpecError("MISSING_ROUTE", spec, "a spec is written route:id");
  }

  const route = spec.slice(0, cut);
  const id = spec.slice(cut + 1);

  if (!ROUTE.test(route)) {
    throw new ModelSpecError("INVALID_ROUTE", spec, `${route} could not be a package name`);
  }
  if (id === "") {
    throw new ModelSpecError("MISSING_ID", spec, "the route names no model");
  }
  return { route, id };
}

/** `openai-compatible` -> `createopenaicompatible`, for a caseless compare. */
function expectedFactory(route: string): string {
  return `create${route.replace(/-/g, "")}`.toLowerCase();
}

type Factory = (settings: Record<string, unknown>) => (id: string) => unknown;

/**
 * Finds the provider factory a package exports.
 *
 * The SDK's naming is consistent in shape but not in casing —
 * `createOpenAI`, `createAnthropic`, `createOpenAICompatible`,
 * `createGoogleGenerativeAI` — so an exact name computed from the route would
 * miss most of them. A caseless match on the route comes first; a package that
 * exports exactly one `create*` function is taken at its word.
 */
function findFactory(
  module: Record<string, unknown>, route: string, specifier: string, spec: string,
): Factory {
  const candidates = Object.keys(module)
    .filter((key) => key.startsWith("create") && typeof module[key] === "function");

  const wanted = expectedFactory(route);
  const exact = candidates.find((key) => key.toLowerCase() === wanted);
  if (exact !== undefined) return module[exact] as Factory;

  if (candidates.length === 1) return module[candidates[0]!] as Factory;
  if (candidates.length === 0) {
    throw new ModelSpecError(
      "FACTORY_MISSING", spec, `${specifier} exports no provider factory`,
    );
  }
  throw new ModelSpecError(
    "FACTORY_AMBIGUOUS", spec,
    `${specifier} exports several factories and none matches the route`,
  );
}

/**
 * Turns a spec into a model, failing early and with a code for every way it can.
 *
 * A key is required unless a base URL was given. A model served from the
 * user's own machine has no key to demand, and the OpenAI-compatible route
 * exists precisely to reach one; when a base URL points at a gateway that does
 * want a key, the omission surfaces as `unauthorized` at verification, which
 * is what verification is for.
 */
export async function resolveModel(spec: string, deps: ResolveDeps): Promise<ResolvedModel> {
  const { route, id } = parseSpec(spec);

  const hasKey = deps.apiKey !== null && deps.apiKey !== "";
  if (!hasKey && (deps.baseUrl === null || deps.baseUrl === "")) {
    throw new ModelSpecError("MISSING_KEY", spec, `${route} has no key configured`);
  }

  const entry = (deps.packages ?? PROVIDER_PACKAGES)[route];
  if (entry === undefined) {
    // Not "the package is missing on this machine": this application does not
    // serve this provider, and saying so is a different sentence with a
    // different remedy — an endpoint typed by hand, not an install.
    throw new ModelSpecError(
      "UNSUPPORTED_ROUTE", spec, `${route} is not a provider this application serves`,
    );
  }

  let module: Record<string, unknown>;
  try {
    module = (await entry.load()) as Record<string, unknown>;
  } catch {
    // Registry and package.json disagreeing is a build failure, not a state
    // the user can reach or repair; the code stays so it is not silent.
    throw new ModelSpecError("PACKAGE_MISSING", spec, `${entry.specifier} is not installed`);
  }

  const factory = findFactory(module, route, entry.specifier, spec);

  // Only what was actually configured is passed: an explicit `baseURL:
  // undefined` is not the same as an absent one to every provider package.
  const settings: Record<string, unknown> = {};
  if (hasKey) settings.apiKey = deps.apiKey;
  if (deps.baseUrl !== null && deps.baseUrl !== "") settings.baseURL = deps.baseUrl;
  if (deps.headers !== undefined && Object.keys(deps.headers).length > 0) {
    settings.headers = deps.headers;
  }
  if (route === GENERIC_ROUTE) {
    settings.name = deps.name ?? route;
    // Without this the generic route drops a schema and sends `json_object`
    // instead — some JSON, of no particular shape — while the instructions
    // that travelled with it said nothing about a format either.
    if (deps.structured === true) settings.supportsStructuredOutputs = true;
  }

  let model: unknown;
  try {
    model = factory(settings)(id);
  } catch (error) {
    throw new ModelSpecError(
      "FACTORY_FAILED", spec,
      `${entry.specifier} refused the model id (${(error as Error).name})`,
    );
  }

  return {
    model,
    // The spec as written, so the cache key names the route as well as the id:
    // the same id on two routes is not the same model.
    modelId: spec,
    options: deps.options,
    ...(deps.structured === undefined ? {} : { structured: deps.structured }),
  };
}
