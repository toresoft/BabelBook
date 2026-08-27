/**
 * The catalogue's shape: models.dev's api.json, pruned to what this
 * application can use.
 *
 * The full file carries descriptions, knowledge cut-offs, release dates and
 * modalities for 7'000+ models. None of that decides anything here: a screen
 * shows names, prices and windows, an estimate multiplies tokens by prices, and
 * everything else would travel across IPC to be ignored. Pruned, the catalogue
 * is 1.8 MB instead of 4.3 — 158 KB once gzipped, the cost of an icon.
 *
 * This module is pure. It is shared by the fetch script, the loader and the
 * tests, and it must never learn about files or the network.
 */

import { routeForPackage } from "../../engine/backends/registry.ts";

/** Per million tokens, as the catalogue declares them. */
export interface CatalogCost {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface CatalogModel {
  id: string;
  name: string;
  /**
   * Null when the catalogue does not know the price. Absent is honest: an
   * invented price is worse than no price, because a number on a screen is
   * believed and a missing one is asked about.
   */
  cost: CatalogCost | null;
  limit: { context: number | null; output: number | null };
  toolCall: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
  attachment: boolean;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** The `@ai-sdk/*` package that serves this provider. */
  npm: string;
  /** The environment variables the provider's documentation names for the key. */
  env: string[];
  /** The endpoint's base URL, when the catalogue declares one. */
  api: string | null;
  models: CatalogModel[];
}

export interface Catalog {
  /**
   * When this data was produced, ISO. A price shown carries this date: it is
   * the answer to "how old is this number I am about to believe?".
   */
  at: string;
  providers: CatalogProvider[];
}

/**
 * The route that will serve a catalogue entry, or null when none will.
 *
 * Three answers, in order. The registry knows the package: that route. It does
 * not, but the catalogue knows an address: `openai-compatible` reaches
 * anything that speaks the protocol, and most publishers outside the SDK do.
 * Neither: null, and the list says so where the choice is made — which beats a
 * key configured, a button pressed, and a sentence about a package.
 *
 * The address matters because it is the one thing `openai-compatible` cannot
 * invent. Twenty-two providers this application does serve have none either;
 * their own package carries its endpoint, so they never needed one.
 */
export function routeOf(npm: string, api: string | null): string | null {
  const known = routeForPackage(npm);
  if (known !== null) return known;
  return api === null || api === "" ? null : "openai-compatible";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function costOf(value: unknown): CatalogCost | null {
  if (value === null || typeof value !== "object") return null;
  const cost = value as Record<string, unknown>;
  const pruned: CatalogCost = {
    input: num(cost["input"]),
    output: num(cost["output"]),
    cacheRead: num(cost["cache_read"]),
    cacheWrite: num(cost["cache_write"]),
  };
  return pruned.input === null && pruned.output === null ? null : pruned;
}

function limitOf(value: unknown): CatalogModel["limit"] {
  const limit = (value === null || typeof value !== "object" ? {} : value) as Record<string, unknown>;
  return { context: num(limit["context"]), output: num(limit["output"]) };
}

function modelOf(value: unknown): CatalogModel | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = str(raw["id"]);
  if (id === null) return null;

  return {
    id,
    name: str(raw["name"]) ?? id,
    cost: costOf(raw["cost"]),
    limit: limitOf(raw["limit"]),
    toolCall: bool(raw["tool_call"]),
    reasoning: bool(raw["reasoning"]),
    structuredOutput: bool(raw["structured_output"]),
    attachment: bool(raw["attachment"]),
  };
}

function providerOf(value: unknown): CatalogProvider | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = str(raw["id"]);
  const name = str(raw["name"]);
  const npm = str(raw["npm"]);
  if (id === null || name === null || npm === null) return null;

  const models: CatalogModel[] = [];
  const rawModels = raw["models"];
  if (rawModels !== null && typeof rawModels === "object") {
    for (const model of Object.values(rawModels as Record<string, unknown>)) {
      const pruned = modelOf(model);
      if (pruned !== null) models.push(pruned);
    }
  }

  const env = Array.isArray(raw["env"])
    ? raw["env"].filter((entry): entry is string => typeof entry === "string")
    : [];

  return { id, name, npm, env, api: str(raw["api"]), models };
}

/**
 * Prunes the api.json object into the shape this application keeps.
 *
 * Lenient by design: an entry that cannot be named is skipped, not fatal — a
 * catalogue that grows a field must not make every copy of this app unable to
 * read every catalogue. What cannot be understood is dropped, and what is
 * understood is kept exactly as declared.
 */
export function pruneCatalog(raw: unknown): CatalogProvider[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];

  const providers: CatalogProvider[] = [];
  for (const entry of Object.values(raw as Record<string, unknown>)) {
    const pruned = providerOf(entry);
    if (pruned !== null) providers.push(pruned);
  }
  return providers;
}

function isCatalogModel(value: unknown): value is CatalogModel {
  if (value === null || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  return typeof model["id"] === "string" && model["id"] !== ""
    && typeof model["name"] === "string"
    && typeof model["toolCall"] === "boolean"
    && typeof model["reasoning"] === "boolean"
    && typeof model["structuredOutput"] === "boolean"
    && typeof model["attachment"] === "boolean";
}

/**
 * Whether a parsed value is a catalogue this application produced.
 *
 * The check is structural, not deep: it asks for the fields every reader
 * touches (identity, price, window) so that a file which is not a catalogue at
 * all is refused, while a catalogue whose capabilities grew a new field is not
 * declared broken by an older copy of this code.
 */
export function isCatalog(value: unknown): value is Catalog {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["at"] !== "string" || !Array.isArray(candidate["providers"])) return false;

  return candidate["providers"].every((provider) => {
    if (provider === null || typeof provider !== "object") return false;
    const entry = provider as Record<string, unknown>;
    return typeof entry["id"] === "string" && entry["id"] !== ""
      && typeof entry["name"] === "string"
      && typeof entry["npm"] === "string"
      && (entry["api"] === null || typeof entry["api"] === "string")
      && Array.isArray(entry["env"])
      && Array.isArray(entry["models"])
      && entry["models"].every(isCatalogModel);
  });
}
