import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import {
  createProvider, deleteProvider, getProvider, listProviders, modelPricesOf, PRESETS, readKey,
  refreshCatalogMetadata, routeDefaults, updateProvider,
} from "../main/providers/store.ts";
import type { Catalog, CatalogProvider } from "../main/catalog/shape.ts";

/**
 * A stand-in for the keyring that actually hides what it is given.
 *
 * Base64 rather than a `enc:` prefix over the plaintext: a fake whose output
 * still contains the key cannot be used to check that the key is not stored in
 * the clear, which is the one thing this suite exists to check.
 */
const crypto = {
  isAvailable: () => true,
  encrypt: (plain: string) => Buffer.from(Buffer.from(`enc:${plain}`, "utf8").toString("base64"), "utf8"),
  decrypt: (blob: Buffer) => Buffer.from(blob.toString("utf8"), "base64").toString("utf8").replace(/^enc:/, ""),
};

function db() {
  const d = openDatabase(":memory:");
  migrate(d, loadMigrations("app/main/db/migrations"));
  return d;
}

const acme = {
  name: "Acme", route: "acme", baseUrl: "https://api.acme.test/v1",
  headers: {}, options: {}, catalogId: null, catalogAt: null,
  models: [{ id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5,
    capabilities: null }],
};

/** A catalogue entry for Acme, as a refresh would carry it. */
const acmeCatalog: CatalogProvider = {
  id: "acme", name: "Acme", npm: "@ai-sdk/acme", env: ["ACME_API_KEY"],
  api: "https://api.acme.test/v1",
  models: [{
    id: "m1", name: "M1",
    cost: { input: 1, output: 5, cacheRead: null, cacheWrite: null },
    limit: { context: 128_000, output: 8_192 },
    toolCall: true, reasoning: false, structuredOutput: true, attachment: false,
  }],
};

const catalogOf = (at: string): Catalog => ({ at, providers: [acmeCatalog] });

describe("providers", () => {
  it("never stores the key in the clear", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    const row = d.prepare("SELECT api_key_encrypted FROM provider WHERE id = ?")
      .get(p.id) as { api_key_encrypted: Uint8Array };
    // node:sqlite hands a BLOB back as a plain Uint8Array, whose
    // `toString("utf8")` is a comma-joined list of decimal byte values: read
    // that way the assertion would hold even on a key written in the clear.
    // Copying into a Buffer first is what makes it mean what it says.
    expect(Buffer.from(row.api_key_encrypted).toString("utf8")).not.toContain("sk-secret");
    expect(readKey(d, crypto, p.id)).toBe("sk-secret");
  });

  it("tells the renderer whether a key is there, and nothing more", () => {
    const d = db();
    createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    const listed = listProviders(d);
    expect(listed[0].hasKey).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("sk-secret");
  });

  it("keeps the existing key when an update does not carry one", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    updateProvider(d, crypto, p.id, { name: "Acme Inc" });
    expect(readKey(d, crypto, p.id)).toBe("sk-secret");
  });

  it("refuses to store a key when the OS keyring is unavailable", () => {
    const d = db();
    const unavailable = { ...crypto, isAvailable: () => false };
    expect(() => createProvider(d, unavailable, { ...acme, apiKey: "sk-secret" }))
      .toThrow(/KEYRING_UNAVAILABLE/);
  });

  it("clears the key only when clearing is said on purpose", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    updateProvider(d, crypto, p.id, { apiKey: null });
    expect(readKey(d, crypto, p.id)).toBeNull();
    expect(getProvider(d, p.id)!.hasKey).toBe(false);
  });

  it("takes a provider and its models away together", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    expect(deleteProvider(d, p.id)).toBe(true);
    expect(getProvider(d, p.id)).toBeNull();
    expect(d.prepare("SELECT count(*) AS n FROM provider_model").get()).toMatchObject({ n: 0 });
  });

  it("ships a preset that reaches any OpenAI-compatible endpoint", () => {
    // The only hand-built case left: the shortcut for what the catalogue does
    // not know — a corporate gateway, a model served from one's own machine.
    // Everything else is chosen from the catalogue instead.
    expect(PRESETS).toHaveLength(1);
    expect(PRESETS[0]).toMatchObject({ route: "openai-compatible", models: [] });
    expect(PRESETS[0]!.catalogId).toBeNull();
  });

  it("keeps the route defaults the hand-written presets used to carry", () => {
    // Not a preference: DeepSeek's reasoning spends the whole output budget on
    // reasoning tokens. A fact about how this application must call the route,
    // which is why it lives here and not in the catalogue.
    expect(routeDefaults("deepseek")).toMatchObject({ deepseek: { thinking: { type: "disabled" } } });
    expect(routeDefaults("anthropic")).toEqual({});
  });

  it("tells the run what its model costs, when the catalogue knew", () => {
    const d = db();
    createProvider(d, crypto, { ...acme, models: [
      { id: "m1", displayName: "M1", contextWindow: null, priceIn: 1, priceOut: 5, capabilities: null },
      { id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null, capabilities: null },
    ] });

    expect(modelPricesOf(d, "any-provider", "m1")).toBeNull(); // no such provider row
    const p = listProviders(d)[0]!;
    expect(modelPricesOf(d, p.id, "m1")).toEqual({ priceIn: 1, priceOut: 5 });
    // Half a price is no price: the estimate refuses to multiply one side.
    expect(modelPricesOf(d, p.id, "m2")).toBeNull();
  });
});

describe("the catalogue binding", () => {
  it("remembers which catalogue entry a provider came from, and when", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, catalogId: "acme", catalogAt: "2026-08-01" });
    expect(getProvider(d, p.id)).toMatchObject({ catalogId: "acme", catalogAt: "2026-08-01" });
  });

  it("carries price, window and capabilities when known, and null when not", () => {
    const d = db();
    const p = createProvider(d, crypto, {
      ...acme,
      models: [
        {
          id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5,
          capabilities: { toolCall: true, reasoning: false, structuredOutput: true, attachment: false },
        },
        {
          id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null,
          capabilities: null,
        },
      ],
    });
    expect(getProvider(d, p.id)!.models).toEqual([
      {
        id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5,
        capabilities: { toolCall: true, reasoning: false, structuredOutput: true, attachment: false },
      },
      {
        id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null,
        capabilities: null,
      },
    ]);
  });

  it("refreshes metadata from the catalogue without touching key or models chosen", () => {
    const d = db();
    const p = createProvider(d, crypto, {
      ...acme, catalogId: "acme", catalogAt: "2026-01-01", apiKey: "sk-secret",
      // m2 is served by the endpoint but unknown to the catalogue; the choice
      // of m2 must survive a refresh that cannot price it.
      models: [
        { id: "m1", displayName: "m1", contextWindow: null, priceIn: null, priceOut: null, capabilities: null },
        { id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null, capabilities: null },
      ],
    });

    refreshCatalogMetadata(d, catalogOf("2026-08-01"));

    const after = getProvider(d, p.id)!;
    expect(after.catalogAt).toBe("2026-08-01");
    expect(after.models).toEqual([
      {
        id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5,
        capabilities: { toolCall: true, reasoning: false, structuredOutput: true, attachment: false },
      },
      { id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null, capabilities: null },
    ]);
    expect(readKey(d, crypto, p.id)).toBe("sk-secret");
  });

  it("leaves a hand-written provider out of a catalogue refresh", () => {
    const d = db();
    const p = createProvider(d, crypto, {
      ...acme, catalogId: null, catalogAt: null,
      models: [{ id: "m1", displayName: "M1", contextWindow: null, priceIn: null, priceOut: null, capabilities: null }],
    });

    refreshCatalogMetadata(d, catalogOf("2026-08-01"));

    const after = getProvider(d, p.id)!;
    expect(after.catalogAt).toBeNull();
    expect(after.models[0]!.priceIn).toBeNull();
  });

  it("skips a provider whose catalogue entry has disappeared, rather than emptying it", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, catalogId: "gone", catalogAt: "2026-01-01" });

    refreshCatalogMetadata(d, { at: "2026-08-01", providers: [] });

    const after = getProvider(d, p.id)!;
    expect(after.catalogAt).toBe("2026-01-01");
    expect(after.models).toHaveLength(1);
  });
});
