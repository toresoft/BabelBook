import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ModelCapabilities, Provider, ProviderInput, ProviderModel, ProviderPatch, ProviderPreset,
} from "../../shared/dto.ts";
import type { Catalog } from "../catalog/shape.ts";

// The shapes live in `shared/dto.ts` because they cross the IPC boundary, and
// a second definition here would be free to drift from the one the renderer
// compiles against. Re-exported so this module stays the place to import a
// provider from.
export type { Provider, ProviderInput, ProviderModel, ProviderPatch, ProviderPreset };

/**
 * The keyring, as an interface rather than as `safeStorage` itself.
 *
 * Electron's module cannot be loaded in a test, and a store that reached for
 * it directly could only be tested by not testing the encryption at all. In
 * production this is `safeStorage`; here it is whatever the caller passes.
 */
export interface Crypto {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

/** Thrown with a code, never with a sentence: the interface owns the words. */
export class ProviderStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProviderStoreError";
    this.code = code;
  }
}

interface ProviderRow {
  id: string;
  name: string;
  route: string;
  base_url: string | null;
  headers: string | null;
  options: string | null;
  catalog_id: string | null;
  catalog_at: string | null;
  has_key: number;
}

interface ModelRow {
  provider_id: string;
  model_id: string;
  display_name: string | null;
  context_window: number | null;
  price_in: number | null;
  price_out: number | null;
  capabilities: string | null;
  reasoning_enabled: number | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A hand-edited database should not stop the application from starting;
    // an unreadable blob of settings is a provider with defaults, not a crash.
    return fallback;
  }
}

function capabilitiesOf(text: string | null): ModelCapabilities | null {
  const parsed = parseJson<ModelCapabilities | null>(text, null);
  return parsed;
}

/**
 * Refuses rather than writes in the clear.
 *
 * A key written unencrypted lives in a file the user copies to a backup, a
 * second machine, an issue attachment. Nothing announces it, and by the time
 * it is noticed the key has already travelled. Failing here is the only moment
 * at which that can still be prevented.
 */
function sealKey(crypto: Crypto, apiKey: string): Buffer {
  if (!crypto.isAvailable()) {
    throw new ProviderStoreError(
      "KEYRING_UNAVAILABLE",
      "the OS keyring is unavailable, so the key cannot be stored",
    );
  }
  return crypto.encrypt(apiKey);
}

function writeModels(db: DatabaseSync, providerId: string, models: ProviderModel[]): void {
  db.prepare("DELETE FROM provider_model WHERE provider_id = ?").run(providerId);
  const insert = db.prepare(`
    INSERT INTO provider_model (id, provider_id, model_id, display_name,
                                context_window, price_in, price_out, capabilities,
                                reasoning_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const model of models) {
    insert.run(
      randomUUID(), providerId, model.id, model.displayName,
      model.contextWindow, model.priceIn, model.priceOut,
      model.capabilities === null ? null : JSON.stringify(model.capabilities),
      model.reasoningEnabled === null || model.reasoningEnabled === undefined
        ? null
        : model.reasoningEnabled ? 1 : 0,
    );
  }
}

function modelsOf(db: DatabaseSync, providerIds: string[]): Map<string, ProviderModel[]> {
  const byProvider = new Map<string, ProviderModel[]>();
  for (const id of providerIds) byProvider.set(id, []);
  if (providerIds.length === 0) return byProvider;

  const rows = db.prepare(`
    SELECT provider_id, model_id, display_name, context_window, price_in, price_out, capabilities,
           reasoning_enabled
      FROM provider_model
     ORDER BY provider_id, rowid
  `).all() as unknown as ModelRow[];

  for (const row of rows) {
    const list = byProvider.get(row.provider_id);
    if (list === undefined) continue;
    list.push({
      id: row.model_id,
      displayName: row.display_name ?? row.model_id,
      contextWindow: row.context_window,
      priceIn: row.price_in,
      priceOut: row.price_out,
      capabilities: capabilitiesOf(row.capabilities),
      reasoningEnabled: row.reasoning_enabled === null ? null : row.reasoning_enabled === 1,
    });
  }
  return byProvider;
}

function toProvider(row: ProviderRow, models: ProviderModel[]): Provider {
  return {
    id: row.id,
    name: row.name,
    route: row.route,
    baseUrl: row.base_url,
    headers: parseJson<Record<string, string>>(row.headers, {}),
    options: parseJson<Record<string, unknown>>(row.options, {}),
    models,
    catalogId: row.catalog_id,
    catalogAt: row.catalog_at,
    hasKey: row.has_key === 1,
  };
}

/**
 * `api_key_encrypted` is never selected here.
 *
 * The column is reduced to a boolean in SQL rather than in TypeScript, so no
 * row object in this process ever holds the bytes to begin with.
 */
const SELECT_PROVIDER = `
  SELECT id, name, route, base_url, headers, options, catalog_id, catalog_at,
         CASE WHEN api_key_encrypted IS NULL THEN 0 ELSE 1 END AS has_key
    FROM provider
`;

export function listProviders(db: DatabaseSync): Provider[] {
  const rows = db.prepare(`${SELECT_PROVIDER} ORDER BY name`).all() as unknown as ProviderRow[];
  const models = modelsOf(db, rows.map((row) => row.id));
  return rows.map((row) => toProvider(row, models.get(row.id) ?? []));
}

export function getProvider(db: DatabaseSync, id: string): Provider | null {
  const row = db.prepare(`${SELECT_PROVIDER} WHERE id = ?`).get(id) as unknown as ProviderRow | undefined;
  if (row === undefined) return null;
  return toProvider(row, modelsOf(db, [row.id]).get(row.id) ?? []);
}

export function createProvider(db: DatabaseSync, crypto: Crypto, input: ProviderInput): Provider {
  const id = randomUUID();
  // Sealing before the transaction opens: an unavailable keyring must leave
  // no half-written provider behind.
  const sealed = input.apiKey === undefined || input.apiKey === null || input.apiKey === ""
    ? null
    : sealKey(crypto, input.apiKey);

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO provider (id, name, route, base_url, api_key_encrypted, headers, options,
                            catalog_id, catalog_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.route, input.baseUrl,
      sealed, JSON.stringify(input.headers ?? {}), JSON.stringify(input.options ?? {}),
      input.catalogId ?? null, input.catalogAt ?? null,
    );
    writeModels(db, id, input.models ?? []);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getProvider(db, id)!;
}

/**
 * Patches what was named and leaves the rest, the key included.
 *
 * An absent `apiKey` means "do not touch it", never "clear it": the renderer
 * cannot send back a key it is not allowed to see, so every edit of a name or
 * a model list would otherwise wipe the credential. Clearing is `null`, which
 * has to be said on purpose.
 */
export function updateProvider(
  db: DatabaseSync, crypto: Crypto, id: string, patch: ProviderPatch,
): Provider {
  const current = getProvider(db, id);
  if (current === null) throw new ProviderStoreError("PROVIDER_UNKNOWN", `no provider ${id}`);

  const sealed = patch.apiKey === undefined || patch.apiKey === ""
    ? undefined
    : patch.apiKey === null ? null : sealKey(crypto, patch.apiKey);

  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE provider
         SET name = ?, route = ?, base_url = ?, headers = ?, options = ?,
             catalog_id = ?, catalog_at = ?
       WHERE id = ?
    `).run(
      patch.name ?? current.name,
      patch.route ?? current.route,
      patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl,
      JSON.stringify(patch.headers ?? current.headers),
      JSON.stringify(patch.options ?? current.options),
      patch.catalogId === undefined ? current.catalogId : patch.catalogId,
      patch.catalogAt === undefined ? current.catalogAt : patch.catalogAt,
      id,
    );
    if (sealed !== undefined) {
      db.prepare("UPDATE provider SET api_key_encrypted = ? WHERE id = ?").run(sealed, id);
    }
    if (patch.models !== undefined) writeModels(db, id, patch.models);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getProvider(db, id)!;
}

/** Models and the key go with it; `provider_model` cascades on its own. */
export function deleteProvider(db: DatabaseSync, id: string): boolean {
  return db.prepare("DELETE FROM provider WHERE id = ?").run(id).changes > 0;
}

/**
 * The one place a key is decoded, and only ever in the main process.
 *
 * An unavailable keyring throws instead of returning null: a stored key that
 * cannot be read is not the same fact as no key at all, and reporting it as
 * "missing" would send the user to type a key they already have.
 */
export function readKey(db: DatabaseSync, crypto: Crypto, id: string): string | null {
  const row = db.prepare("SELECT api_key_encrypted FROM provider WHERE id = ?")
    .get(id) as unknown as { api_key_encrypted: Uint8Array | null } | undefined;
  if (row === undefined || row.api_key_encrypted === null) return null;

  if (!crypto.isAvailable()) {
    throw new ProviderStoreError(
      "KEYRING_UNAVAILABLE",
      "the OS keyring is unavailable, so the stored key cannot be read",
    );
  }
  // node:sqlite yields a plain Uint8Array; `Crypto` speaks Buffer, and
  // `safeStorage.decryptString` accepts nothing else.
  return crypto.decrypt(Buffer.from(row.api_key_encrypted));
}

export function routeDefaults(route: string): Record<string, unknown> {
  return {};
}

/**
 * How each route spells "do not think about it".
 *
 * The idea is one and the words are four, so the translation table lives in a
 * single place — the same reason `routeDefaults` is here. On, nothing is said:
 * a budget this application picked would be a number nobody measured.
 */
const ROUTE_REASONING: Record<string, { field: string; off: unknown }> = {
  anthropic: { field: "thinking", off: { type: "disabled" } },
  deepseek: { field: "thinking", off: { type: "disabled" } },
  openai: { field: "reasoningEffort", off: "minimal" },
  google: { field: "thinkingConfig", off: { thinkingBudget: 0 } },
};

export function routeReasoning(route: string, enabled: boolean): Record<string, unknown> {
  if (enabled) return {};
  const setting = ROUTE_REASONING[route];
  return setting === undefined ? {} : { [route]: { [setting.field]: setting.off } };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Resolves stored options into the options for one call.
 *
 * Reasoning owns only one field inside the route's namespace. Everything else
 * survives; the owned field is first removed so neither an old application
 * default nor a hand-written option can contradict the resolved cache identity.
 */
export function resolveRouteOptions(
  route: string, stored: Record<string, unknown>, reasoning: boolean,
): Record<string, unknown> {
  const defaults = routeDefaults(route);
  const resolved = { ...stored, ...defaults };
  const setting = ROUTE_REASONING[route];
  if (setting === undefined) return resolved;

  const routeOptions = { ...record(stored[route]), ...record(defaults[route]) };
  delete routeOptions[setting.field];
  Object.assign(routeOptions, record(routeReasoning(route, reasoning)[route]));

  if (Object.keys(routeOptions).length === 0) delete resolved[route];
  else resolved[route] = routeOptions;
  return resolved;
}

/** The resolved runtime choice: an unchosen model reasons off. */
export function reasoningOf(db: DatabaseSync, providerId: string, modelId: string): boolean {
  const row = db.prepare(`
    SELECT reasoning_enabled FROM provider_model
     WHERE provider_id = ? AND model_id = ?
  `).get(providerId, modelId) as { reasoning_enabled: number | null } | undefined;
  return row?.reasoning_enabled === 1;
}

/** Persists the user's choice; null restores the distinct unchosen state. */
export function setReasoning(
  db: DatabaseSync, providerId: string, modelId: string, enabled: boolean | null,
): void {
  db.prepare(`
    UPDATE provider_model SET reasoning_enabled = ?
     WHERE provider_id = ? AND model_id = ?
  `).run(enabled === null ? null : enabled ? 1 : 0, providerId, modelId);
}

/**
 * The prices a project's model carries, for pricing a run at its own moment.
 *
 * Null when either side is unknown: half a price is no price, and an estimate
 * that multiplies one side only would understate what a book costs — the one
 * direction of wrong that reads like a promise.
 */
export function modelPricesOf(
  db: DatabaseSync, providerId: string, modelId: string,
): { priceIn: number; priceOut: number } | null {
  const row = db.prepare(`
    SELECT price_in, price_out FROM provider_model
     WHERE provider_id = ? AND model_id = ?
  `).get(providerId, modelId) as
    { price_in: number | null; price_out: number | null } | undefined;
  if (row === undefined || row.price_in === null || row.price_out === null) return null;
  return { priceIn: row.price_in, priceOut: row.price_out };
}

/**
 * The context window the catalogue declared for a project's model, in tokens.
 *
 * Null when unknown: the planner then keeps the budget it has always used,
 * which is the reference behaviour, not a fallback that guesses.
 */
export function modelContextOf(db: DatabaseSync, providerId: string, modelId: string): number | null {
  const row = db.prepare(`
    SELECT context_window FROM provider_model
     WHERE provider_id = ? AND model_id = ?
  `).get(providerId, modelId) as { context_window: number | null } | undefined;
  return row?.context_window ?? null;
}

/**
 * The one preset that stays hand-built: the shortcut for endpoints the
 * catalogue does not know — OpenRouter, a corporate gateway, a model served
 * from the user's own machine. They differ by base URL, not by protocol, and
 * it ships with no models because only the endpoint knows what it serves.
 *
 * Every other provider is chosen from the catalogue, where the models, the
 * prices and the windows come from.
 */
export const PRESETS: ProviderPreset[] = [
  {
    name: "OpenAI-compatible",
    route: "openai-compatible",
    baseUrl: "",
    headers: {},
    options: {},
    catalogId: null,
    catalogAt: null,
    models: [],
  },
];

/**
 * Refreshes the metadata of every provider bound to the catalogue.
 *
 * What it touches: prices, windows, capabilities, display names — the things
 * the catalogue knows. What it never touches: the model list itself (the
 * endpoint owns that), the key, and any model a project has chosen. A model
 * the new catalogue no longer mentions keeps what it had: the price of
 * yesterday stays yesterday's, dated by `catalog_at`, which is what makes an
 * estimate made last week still explainable.
 */
export function refreshCatalogMetadata(db: DatabaseSync, catalog: Catalog): void {
  const bound = db.prepare(`
    SELECT id, catalog_id FROM provider WHERE catalog_id IS NOT NULL
  `).all() as unknown as Array<{ id: string; catalog_id: string }>;

  db.exec("BEGIN");
  try {
    const stamp = db.prepare("UPDATE provider SET catalog_at = ? WHERE id = ?");
    const updateModel = db.prepare(`
      UPDATE provider_model
         SET display_name = ?, context_window = ?, price_in = ?, price_out = ?,
             capabilities = ?
       WHERE provider_id = ? AND model_id = ?
    `);

    for (const provider of bound) {
      const entry = catalog.providers.find((candidate) => candidate.id === provider.catalog_id);
      // A provider whose entry has disappeared keeps what it has: emptying it
      // because a catalogue grew smaller would take working models away.
      if (entry === undefined) continue;

      stamp.run(catalog.at, provider.id);
      const stored = db.prepare("SELECT model_id FROM provider_model WHERE provider_id = ?")
        .all(provider.id) as unknown as Array<{ model_id: string }>;
      for (const row of stored) {
        const known = entry.models.find((model) => model.id === row.model_id);
        if (known === undefined) continue;
        updateModel.run(
          known.name, known.limit.context, known.cost?.input ?? null, known.cost?.output ?? null,
          JSON.stringify({
            toolCall: known.toolCall, reasoning: known.reasoning,
            structuredOutput: known.structuredOutput, attachment: known.attachment,
          }),
          provider.id, row.model_id,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
