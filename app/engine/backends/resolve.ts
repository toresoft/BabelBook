/**
 * From a written model spec to something the AI SDK can call.
 *
 * The whole point of this file is that it runs *before* the book is opened.
 * A missing package, an absent key or a malformed spec must surface at the
 * start of a run, not at the first chunk — by then analysis has already been
 * paid for, and the user is looking at a progress bar that will never finish.
 */

/**
 * A spec that cannot become a model, with a code the interface can translate.
 *
 * `spec` travels with the error because a run names one model and the message
 * shown to the user has to say which one; the code is what the catalogue keys
 * off, never the sentence.
 */
export class ModelSpecError extends Error {
  readonly spec: string;
  readonly code: string;

  constructor(code: string, spec: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ModelSpecError";
    this.code = code;
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
}

/**
 * How a package is fetched, injected rather than hard-wired.
 *
 * The provider packages are the user's to install, and no test may install
 * one or reach the network. In production this is `(s) => import(s)`.
 */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

export interface ResolveDeps {
  load: ModuleLoader;
  apiKey: string | null;
  baseUrl: string | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
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
function findFactory(module: Record<string, unknown>, route: string, spec: string): Factory {
  const candidates = Object.keys(module)
    .filter((key) => key.startsWith("create") && typeof module[key] === "function");

  const wanted = expectedFactory(route);
  const exact = candidates.find((key) => key.toLowerCase() === wanted);
  if (exact !== undefined) return module[exact] as Factory;

  if (candidates.length === 1) return module[candidates[0]!] as Factory;
  if (candidates.length === 0) {
    throw new ModelSpecError(
      "FACTORY_MISSING", spec, `@ai-sdk/${route} exports no provider factory`,
    );
  }
  throw new ModelSpecError(
    "FACTORY_AMBIGUOUS", spec,
    `@ai-sdk/${route} exports several factories and none matches the route`,
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

  const specifier = `@ai-sdk/${route}`;
  let module: Record<string, unknown>;
  try {
    module = (await deps.load(specifier)) as Record<string, unknown>;
  } catch {
    // The loader's message names a path on this machine and is in English;
    // the interface says "install @ai-sdk/<route>" from its own catalogue.
    throw new ModelSpecError("PACKAGE_MISSING", spec, `${specifier} is not installed`);
  }

  const factory = findFactory(module, route, spec);

  // Only what was actually configured is passed: an explicit `baseURL:
  // undefined` is not the same as an absent one to every provider package.
  const settings: Record<string, unknown> = {};
  if (hasKey) settings.apiKey = deps.apiKey;
  if (deps.baseUrl !== null && deps.baseUrl !== "") settings.baseURL = deps.baseUrl;
  if (deps.headers !== undefined && Object.keys(deps.headers).length > 0) {
    settings.headers = deps.headers;
  }

  let model: unknown;
  try {
    model = factory(settings)(id);
  } catch (error) {
    throw new ModelSpecError(
      "FACTORY_FAILED", spec,
      `@ai-sdk/${route} refused the model id (${(error as Error).name})`,
    );
  }

  return {
    model,
    // The spec as written, so the cache key names the route as well as the id:
    // the same id on two routes is not the same model.
    modelId: spec,
    options: deps.options,
  };
}
