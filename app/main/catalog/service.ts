import type { CatalogEntry, CatalogState, ProviderModel } from "../../shared/dto.ts";
import { routeDefaults } from "../providers/store.ts";
import { enrichModels } from "./enrich.ts";
import { discoverModels } from "./discover.ts";
import { routeOf, type Catalog, type CatalogProvider } from "./shape.ts";

/**
 * The catalogue as the window may ask it: search it, ask one entry what it
 * serves, and say how old the whole thing is.
 *
 * The state is held by the caller (the main process, at startup) and passed
 * in, so nothing here owns a lifecycle and every function stays a question
 * about data rather than about the world.
 */

/** 203 entries do not scroll; a picker that types gets a short list back. */
const SEARCH_LIMIT = 12;

function toEntry(provider: CatalogProvider): CatalogEntry {
  const route = routeOf(provider.npm, provider.api);
  return {
    id: provider.id,
    name: provider.name,
    route,
    baseUrl: provider.api,
    options: route === null ? {} : routeDefaults(route),
    models: provider.models.length,
  };
}

/** Matches on id and name, case-insensitively; an empty query matches nothing. */
export function searchCatalog(catalog: Catalog, query: string): CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  return catalog.providers
    .filter((provider) =>
      provider.id.toLowerCase().includes(needle)
      || provider.name.toLowerCase().includes(needle))
    .slice(0, SEARCH_LIMIT)
    .map(toEntry);
}

/**
 * What one entry serves.
 *
 * An entry that declares a URL is asked: the endpoint is the truth about what
 * this key can reach, and a refused key says so here. An entry without one —
 * OpenAI, Anthropic, the packages that carry their own default — cannot be
 * asked, and answers with the catalogue's own list, which for a cloud
 * provider is the publisher's list. No URL is ever invented to fill the gap.
 */
export async function modelsForEntry(
  catalog: Catalog,
  entryId: string,
  apiKey: string | null,
): Promise<ProviderModel[]> {
  const entry = catalog.providers.find((provider) => provider.id === entryId);
  if (entry === undefined) {
    throw new Error(`unknown-entry: no catalogue entry ${entryId}`);
  }

  if (entry.api === null) {
    return enrichModels(entry.models.map((model) => model.id), entry);
  }
  const discovered = await discoverModels({ baseUrl: entry.api, apiKey });
  return enrichModels(discovered.map((model) => model.id), entry);
}

/** Asks any compatible URL what it serves, with no metadata to add. */
export async function discoverFromUrl(
  baseUrl: string,
  apiKey: string | null,
): Promise<ProviderModel[]> {
  const discovered = await discoverModels({ baseUrl, apiKey });
  return enrichModels(discovered.map((model) => model.id), null);
}

export function catalogState(
  catalog: Catalog, bundled: boolean, checkedAt: string | null = null,
): CatalogState {
  return {
    at: catalog.at,
    providers: catalog.providers.length,
    models: catalog.providers.reduce((total, provider) => total + provider.models.length, 0),
    bundled,
    checkedAt,
  };
}
