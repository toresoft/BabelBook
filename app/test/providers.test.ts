import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import {
  createProvider, deleteProvider, getProvider, listProviders, modelPricesOf, PRESETS, readKey,
  providerNameOf, reasoningOf, reasoningOptions, refreshCatalogMetadata, resolveProviderOptions,
  refuseCapability, routeDefaults, setReasoning, structuredAccepted, structuredOf, updateProvider,
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
    capabilities: null, reasoningLevel: null }],
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
    expect(routeDefaults("deepseek")).toEqual({});
    expect(routeDefaults("anthropic")).toEqual({});
  });

  it("tells the run what its model costs, when the catalogue knew", () => {
    const d = db();
    createProvider(d, crypto, { ...acme, models: [
      {
        id: "m1", displayName: "M1", contextWindow: null, priceIn: 1, priceOut: 5,
        capabilities: null, reasoningLevel: null,
      },
      {
        id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null,
        capabilities: null, reasoningLevel: null,
      },
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
          reasoningLevel: null,
        },
        {
          id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null,
          capabilities: null,
          reasoningLevel: null,
        },
      ],
    });
    expect(getProvider(d, p.id)!.models).toEqual([
      {
        id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5,
        capabilities: { toolCall: true, reasoning: false, structuredOutput: true, attachment: false },
        reasoningLevel: null,
      },
      {
        id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null,
        capabilities: null,
        reasoningLevel: null,
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
        {
          id: "m1", displayName: "m1", contextWindow: null, priceIn: null, priceOut: null,
          capabilities: null, reasoningLevel: null,
        },
        {
          id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null,
          capabilities: null, reasoningLevel: null,
        },
      ],
    });

    refreshCatalogMetadata(d, catalogOf("2026-08-01"));

    const after = getProvider(d, p.id)!;
    expect(after.catalogAt).toBe("2026-08-01");
    expect(after.models).toEqual([
      {
        id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5,
        capabilities: { toolCall: true, reasoning: false, structuredOutput: true, attachment: false },
        reasoningLevel: null,
      },
      {
        id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null,
        capabilities: null, reasoningLevel: null,
      },
    ]);
    expect(readKey(d, crypto, p.id)).toBe("sk-secret");
  });

  it("leaves a hand-written provider out of a catalogue refresh", () => {
    const d = db();
    const p = createProvider(d, crypto, {
      ...acme, catalogId: null, catalogAt: null,
      models: [{
        id: "m1", displayName: "M1", contextWindow: null, priceIn: null, priceOut: null,
        capabilities: null, reasoningLevel: null,
      }],
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

/**
 * Facts about how this application must call a route, not about what the route
 * serves — the same reason `routeDefaults` lives here and not in a catalogue.
 * Each route spells the same idea differently, and this is the one place that
 * knows how.
 */
/**
 * Production break: a provider the catalogue knows, reached through the
 * generic route, was addressed by the protocol it speaks instead of by who
 * answers. `reasoning off` was written for `deepseek` and sent to
 * `openai-compatible`, which is nobody, so DeepSeek reasoned through a whole
 * book while the cache key recorded that it had not.
 */
describe("the name a provider's options are keyed by", () => {
  it("is the catalogue's identity when the route is only a protocol", () => {
    expect(providerNameOf("openai-compatible", "deepseek")).toBe("deepseek");
  });

  it("is the route itself when the route is a package", () => {
    expect(providerNameOf("anthropic", "anthropic")).toBe("anthropic");
    expect(providerNameOf("google-vertex-anthropic", "anthropic"))
      .toBe("google-vertex-anthropic");
  });

  /** An endpoint typed by hand belongs to no catalogue and gets no dialect. */
  it("stays the generic route when no catalogue answers for it", () => {
    expect(providerNameOf("openai-compatible", null)).toBe("openai-compatible");
    expect(providerNameOf("openai-compatible", "")).toBe("openai-compatible");
  });

  it("turns the reasoning off in the words of who answers, not of the protocol", () => {
    expect(resolveProviderOptions(providerNameOf("openai-compatible", "deepseek"), {}, "off"))
      .toEqual({ deepseek: { thinking: { type: "disabled" } } });
  });
});

describe("the reasoning options of a provider", () => {
  it("turns it off in the words each one uses", () => {
    expect(reasoningOptions("anthropic", "off")).toMatchObject({ anthropic: { thinking: { type: "disabled" } } });
    expect(reasoningOptions("deepseek", "off")).toMatchObject({ deepseek: { thinking: { type: "disabled" } } });
    expect(reasoningOptions("openai", "off")).toMatchObject({ openai: { reasoningEffort: "minimal" } });
    expect(reasoningOptions("google", "off"))
      .toMatchObject({ google: { thinkingConfig: { thinkingBudget: 0 } } });
  });

  /**
   * Production break: a switch could say only whether to think, so a book was
   * translated with the thinking off — the only alternative there was — and
   * the model answered a third of it in another language.
   */
  it("asks for a strength where the provider has words for one", () => {
    expect(reasoningOptions("deepseek", "low"))
      .toEqual({ deepseek: { thinking: { type: "enabled" }, reasoningEffort: "low" } });
    expect(reasoningOptions("deepseek", "max"))
      .toEqual({ deepseek: { thinking: { type: "enabled" }, reasoningEffort: "max" } });
    // OpenAI's ladder stops at high, so `max` asks for the most it has.
    expect(reasoningOptions("openai", "max")).toEqual({ openai: { reasoningEffort: "high" } });
    expect(reasoningOptions("openai", "low")).toEqual({ openai: { reasoningEffort: "low" } });
  });

  /**
   * Where a provider has no words for a strength, anything but off leaves it
   * its own default. Naming a budget this application has no way to choose
   * would be inventing one, the same refusal as an invented price.
   */
  it("says nothing at all where there is no strength to name", () => {
    expect(reasoningOptions("anthropic", "high")).toEqual({});
    expect(reasoningOptions("google", "low")).toEqual({});
  });

  it("says nothing for a provider it does not know", () => {
    expect(reasoningOptions("acme", "off")).toEqual({});
  });

  it("replaces only the reasoning field when off", () => {
    expect(resolveProviderOptions("google", {
      audit: { trace: true },
      google: {
        safetySettings: [{ category: "danger", threshold: "block-none" }],
        thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
      },
    }, "off")).toEqual({
      audit: { trace: true },
      google: {
        safetySettings: [{ category: "danger", threshold: "block-none" }],
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  });

  it("removes persisted reasoning directives when a strength is asked for", () => {
    expect(resolveProviderOptions("anthropic", {
      anthropic: { temperature: 0.2, thinking: { type: "enabled", budgetTokens: 1024 } },
    }, "high")).toEqual({ anthropic: { temperature: 0.2 } });
    expect(resolveProviderOptions("deepseek", {
      deepseek: { temperature: 0.3, thinking: { type: "disabled" } },
    }, "high")).toEqual({
      deepseek: { temperature: 0.3, thinking: { type: "enabled" }, reasoningEffort: "high" },
    });
    expect(resolveProviderOptions("openai", {
      openai: { store: false, reasoningEffort: "high" },
    }, "low")).toEqual({ openai: { store: false, reasoningEffort: "low" } });
    expect(resolveProviderOptions("google", {
      google: { safetySettings: [], thinkingConfig: { thinkingBudget: 4096 } },
    }, "high")).toEqual({ google: { safetySettings: [] } });
  });
});

describe("the reasoning of a model", () => {
  /**
   * Off, until someone says otherwise. Translation gains nothing from
   * reasoning and loses the output budget to it: the chunk comes back empty
   * with `finishReason: "length"`, every unit in it falls back to the source,
   * and the call is billed in full.
   */
  it("is off when nothing was chosen", () => {
    const d = db();
    const provider = createProvider(d, crypto, { ...acme, apiKey: "k" });
    expect(reasoningOf(d, provider.id, "m1")).toBe("off");
  });

  it("is the strength that was chosen once one was", () => {
    const d = db();
    const provider = createProvider(d, crypto, { ...acme, apiKey: "k" });
    for (const level of ["low", "high", "max", "off"] as const) {
      setReasoning(d, provider.id, "m1", level);
      expect(reasoningOf(d, provider.id, "m1")).toBe(level);
    }
  });

  /** Null is not false: "not chosen" and "chosen off" are different facts. */
  it("goes back to unchosen, and reads as off", () => {
    const d = db();
    const provider = createProvider(d, crypto, { ...acme, apiKey: "k" });
    setReasoning(d, provider.id, "m1", "high");
    setReasoning(d, provider.id, "m1", null);

    expect(reasoningOf(d, provider.id, "m1")).toBe("off");
    expect(listProviders(d)[0]!.models[0]!.reasoningLevel).toBeNull();
  });
});

/**
 * A capability the catalogue claims and a capability the endpoint grants are
 * two different facts, and this is the suite that keeps them apart.
 *
 * They used to share one column, which is how a refusal came to rewrite what
 * the catalogue had said. The cache key is computed from the declaration, so
 * that rewrite moved the key of every project on that model, and a book
 * paused at ninety-seven per cent came back to be translated from the start.
 */
describe("what the endpoint refused", () => {
  /** Acme's catalogue claims the shape; whether the endpoint grants it is another matter. */
  const claiming = {
    ...acme,
    models: [{
      ...acme.models[0]!,
      capabilities: {
        toolCall: true, reasoning: false, structuredOutput: true, attachment: false,
      },
    }],
  };

  it("does not touch what the catalogue declared", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...claiming, apiKey: "k" });

    refuseCapability(d, p.id, "m1", "structuredOutput");

    expect(structuredOf(d, p.id, "m1")).toBe(true);
  });

  it("is what the backend asks before it sends a schema", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...claiming, apiKey: "k" });
    expect(structuredAccepted(d, p.id, "m1")).toBe(true);

    refuseCapability(d, p.id, "m1", "structuredOutput");

    expect(structuredAccepted(d, p.id, "m1")).toBe(false);
  });

  it("has nothing to grant where the catalogue claimed nothing", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "k" });

    expect(structuredAccepted(d, p.id, "m1")).toBe(false);
  });

  /**
   * The refresh replaces `capabilities` wholesale, which is its job: the
   * catalogue owns that column. A refusal written into it therefore lived
   * until the next start of the application and no longer.
   */
  it("survives a catalogue refresh, because the catalogue does not own it", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...claiming, apiKey: "k", catalogId: "acme" });
    refuseCapability(d, p.id, "m1", "structuredOutput");

    refreshCatalogMetadata(d, catalogOf("2026-09-06"));

    expect(structuredOf(d, p.id, "m1")).toBe(true);
    expect(structuredAccepted(d, p.id, "m1")).toBe(false);
  });
});
