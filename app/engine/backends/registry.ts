/**
 * Every provider package this application ships, named once.
 *
 * The alternative — composing `@ai-sdk/${route}` from a string read out of the
 * database — is what this file replaces. It could not reach a package outside
 * the `@ai-sdk` scope, so a third of the catalogue's publishers were offered
 * and then failed at verification; and it made the set of packages something
 * no build step could see, so none of them shipped.
 *
 * Written as thunks rather than top-level imports: naming them here must not
 * cost the start-up time of loading every package nobody asked for.
 * Written as literal specifiers rather than a variable: a bundler and a
 * packager can both see a literal, and neither can see a name computed at
 * runtime.
 *
 * A package may enter this file only if it depends on `@ai-sdk/provider@4`,
 * the spec `ai@7` speaks. One built on the 3.x line imports cleanly and hands
 * back a model of a different shape, so the failure lands at the first call
 * rather than here.
 */

/**
 * The one route that is a protocol rather than a publisher.
 *
 * Every other route is a package, and a package is also a name. This one
 * reaches anything that speaks OpenAI's dialect, so it is the only route that
 * has to be told who is answering.
 */
export const GENERIC_ROUTE = "openai-compatible";

export interface ProviderPackage {
  /** The npm specifier, which messages name and the catalogue is matched on. */
  readonly specifier: string;
  /** A literal import, so the bundler and the packager both see the package. */
  readonly load: () => Promise<unknown>;
}

export type ProviderPackages = Readonly<Record<string, ProviderPackage>>;

/** The route is the key, and the route is what a model spec carries. */
export const PROVIDER_PACKAGES: ProviderPackages = {
  "openai-compatible": {
    specifier: "@ai-sdk/openai-compatible",
    load: () => import("@ai-sdk/openai-compatible"),
  },
  anthropic: { specifier: "@ai-sdk/anthropic", load: () => import("@ai-sdk/anthropic") },
  openai: { specifier: "@ai-sdk/openai", load: () => import("@ai-sdk/openai") },
  azure: { specifier: "@ai-sdk/azure", load: () => import("@ai-sdk/azure") },
  google: { specifier: "@ai-sdk/google", load: () => import("@ai-sdk/google") },
  "google-vertex": {
    specifier: "@ai-sdk/google-vertex",
    load: () => import("@ai-sdk/google-vertex"),
  },
  // A subpath of a package already here, not a package of its own: Vertex
  // serves Anthropic's models through an entry point of its own.
  "google-vertex-anthropic": {
    specifier: "@ai-sdk/google-vertex/anthropic",
    load: () => import("@ai-sdk/google-vertex/anthropic"),
  },
  mistral: { specifier: "@ai-sdk/mistral", load: () => import("@ai-sdk/mistral") },
  groq: { specifier: "@ai-sdk/groq", load: () => import("@ai-sdk/groq") },
  xai: { specifier: "@ai-sdk/xai", load: () => import("@ai-sdk/xai") },
  cohere: { specifier: "@ai-sdk/cohere", load: () => import("@ai-sdk/cohere") },
  perplexity: { specifier: "@ai-sdk/perplexity", load: () => import("@ai-sdk/perplexity") },
  togetherai: { specifier: "@ai-sdk/togetherai", load: () => import("@ai-sdk/togetherai") },
  cerebras: { specifier: "@ai-sdk/cerebras", load: () => import("@ai-sdk/cerebras") },
  deepinfra: { specifier: "@ai-sdk/deepinfra", load: () => import("@ai-sdk/deepinfra") },
  gateway: { specifier: "@ai-sdk/gateway", load: () => import("@ai-sdk/gateway") },
  "amazon-bedrock": {
    specifier: "@ai-sdk/amazon-bedrock",
    load: () => import("@ai-sdk/amazon-bedrock"),
  },

  // Published outside the `@ai-sdk` scope. These are the ones the old
  // composition could not name at all; their routes are new, and no project
  // has ever translated with them, so no cache depends on the names chosen.
  openrouter: {
    specifier: "@openrouter/ai-sdk-provider",
    load: () => import("@openrouter/ai-sdk-provider"),
  },
  qvac: { specifier: "@qvac/ai-sdk-provider", load: () => import("@qvac/ai-sdk-provider") },
  salad: {
    specifier: "@saladtechnologies-oss/ai-sdk-provider",
    load: () => import("@saladtechnologies-oss/ai-sdk-provider"),
  },
  gitlab: { specifier: "gitlab-ai-provider", load: () => import("gitlab-ai-provider") },
  "ai-gateway": { specifier: "ai-gateway-provider", load: () => import("ai-gateway-provider") },
};

const BY_PACKAGE = new Map(
  Object.entries(PROVIDER_PACKAGES).map(([route, entry]) => [entry.specifier, route]),
);

/**
 * The route that serves a catalogue package, or null when none does.
 *
 * Null is an answer, not a failure: the catalogue is refreshed from the
 * network and may name a publisher this application does not ship. What
 * happens next is the caller's decision, and it is taken where the caller can
 * still see the endpoint's address.
 */
export function routeForPackage(npm: string): string | null {
  return BY_PACKAGE.get(npm) ?? null;
}
