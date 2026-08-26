import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  Provider, ProviderInput, ProviderModel, ProviderPatch, ProviderPreset,
} from "../../shared/dto.ts";

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
  has_key: number;
}

interface ModelRow {
  provider_id: string;
  model_id: string;
  display_name: string | null;
  context_window: number | null;
  price_in: number | null;
  price_out: number | null;
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
                                context_window, price_in, price_out)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const model of models) {
    insert.run(
      randomUUID(), providerId, model.id, model.displayName,
      model.contextWindow, model.priceIn, model.priceOut,
    );
  }
}

function modelsOf(db: DatabaseSync, providerIds: string[]): Map<string, ProviderModel[]> {
  const byProvider = new Map<string, ProviderModel[]>();
  for (const id of providerIds) byProvider.set(id, []);
  if (providerIds.length === 0) return byProvider;

  const rows = db.prepare(`
    SELECT provider_id, model_id, display_name, context_window, price_in, price_out
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
  SELECT id, name, route, base_url, headers, options,
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
      INSERT INTO provider (id, name, route, base_url, api_key_encrypted, headers, options)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.route, input.baseUrl,
      sealed, JSON.stringify(input.headers ?? {}), JSON.stringify(input.options ?? {}),
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
         SET name = ?, route = ?, base_url = ?, headers = ?, options = ?
       WHERE id = ?
    `).run(
      patch.name ?? current.name,
      patch.route ?? current.route,
      patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl,
      JSON.stringify(patch.headers ?? current.headers),
      JSON.stringify(patch.options ?? current.options),
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

/**
 * Starting values for the endpoints most people reach for.
 *
 * Presets are values, not cages: everything here is editable afterwards, and
 * the model lists are a starting point rather than a catalogue — an id that
 * has moved on is corrected in the form, not in this file.
 *
 * Prices are left null on purpose. They change without notice, and a stale
 * number would be believed: the estimate is better shown in tokens until the
 * user fills in what their contract actually says.
 */
export const PRESETS: ProviderPreset[] = [
  {
    name: "Anthropic",
    route: "anthropic",
    baseUrl: null,
    headers: {},
    options: {},
    models: [
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", contextWindow: 200_000, priceIn: null, priceOut: null },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", contextWindow: 200_000, priceIn: null, priceOut: null },
      { id: "claude-opus-4-1", displayName: "Claude Opus 4.1", contextWindow: 200_000, priceIn: null, priceOut: null },
    ],
  },
  {
    name: "OpenAI",
    route: "openai",
    baseUrl: null,
    headers: {},
    options: {},
    models: [
      { id: "gpt-4.1", displayName: "GPT-4.1", contextWindow: 1_000_000, priceIn: null, priceOut: null },
      { id: "gpt-4.1-mini", displayName: "GPT-4.1 mini", contextWindow: 1_000_000, priceIn: null, priceOut: null },
      { id: "gpt-4o", displayName: "GPT-4o", contextWindow: 128_000, priceIn: null, priceOut: null },
    ],
  },
  {
    name: "DeepSeek",
    route: "deepseek",
    baseUrl: null,
    headers: {},
    // Not a preference: reasoning is on by default and spends the whole output
    // budget on reasoning tokens. The chunk comes back empty with
    // `finishReason: "length"`, every unit in it falls back to the source, and
    // the call is billed in full. Overridable, but wrong to omit.
    options: { deepseek: { thinking: { type: "disabled" } } },
    models: [
      { id: "deepseek-chat", displayName: "DeepSeek Chat", contextWindow: 128_000, priceIn: null, priceOut: null },
      { id: "deepseek-reasoner", displayName: "DeepSeek Reasoner", contextWindow: 128_000, priceIn: null, priceOut: null },
    ],
  },
  {
    name: "Mistral",
    route: "mistral",
    baseUrl: null,
    headers: {},
    options: {},
    models: [
      { id: "mistral-large-latest", displayName: "Mistral Large", contextWindow: 128_000, priceIn: null, priceOut: null },
      { id: "mistral-medium-latest", displayName: "Mistral Medium", contextWindow: 128_000, priceIn: null, priceOut: null },
    ],
  },
  {
    // One preset covers OpenRouter, a corporate gateway and a model served
    // from the user's own machine: they differ by base URL, not by protocol.
    // It ships with no models, because only the endpoint knows what it serves.
    name: "OpenAI-compatible",
    route: "openai-compatible",
    baseUrl: "",
    headers: {},
    options: {},
    models: [],
  },
];
