import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { routeForPackage } from "../engine/backends/registry.ts";
import { pruneCatalog, routeOf, type CatalogProvider } from "../main/catalog/shape.ts";
import { searchCatalog } from "../main/catalog/service.ts";
import { CATALOG_URL, readCatalog, refreshCatalog } from "../main/catalog/load.ts";
import { enrichModels } from "../main/catalog/enrich.ts";

/**
 * A slice of the real api.json, with the fields the catalogue actually carries
 * — and a few it also carries but nothing here can use.
 */
const RAW_ACME = {
  id: "acme",
  name: "Acme",
  npm: "@ai-sdk/openai-compatible",
  env: ["ACME_API_KEY"],
  api: "https://api.acme.test/v1",
  doc: "https://doc.acme.test",
  models: {
    "acme-mini": {
      id: "acme-mini",
      name: "Acme Mini",
      description: "a sentence nobody shows",
      knowledge: "2024-01",
      release_date: "2024-05-13",
      family: "mini",
      open_weights: false,
      temperature: true,
      modalities: { input: ["text"], output: ["text"] },
      tool_call: true,
      reasoning: false,
      structured_output: true,
      attachment: false,
      limit: { context: 128_000, output: 8_192 },
      cost: { input: 0.5, output: 2, cache_read: 0.1, cache_write: 0.2 },
    },
    "acme-bare": { id: "acme-bare" },
  },
};

const PRUNED_ACME: CatalogProvider = {
  id: "acme",
  name: "Acme",
  npm: "@ai-sdk/openai-compatible",
  env: ["ACME_API_KEY"],
  api: "https://api.acme.test/v1",
  models: [
    {
      id: "acme-mini",
      name: "Acme Mini",
      cost: { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      limit: { context: 128_000, output: 8_192 },
      toolCall: true,
      reasoning: false,
      structuredOutput: true,
      attachment: false,
    },
    {
      // A model the catalogue knows nothing about but its name: no price, no
      // window, no capabilities — absent, never invented.
      id: "acme-bare",
      name: "acme-bare",
      cost: null,
      limit: { context: null, output: null },
      toolCall: false,
      reasoning: false,
      structuredOutput: false,
      attachment: false,
    },
  ],
};

describe("the catalogue shape", () => {
  it("keeps npm, env, api, cost, limits and capabilities, and drops the rest", () => {
    const pruned = pruneCatalog({ acme: RAW_ACME });
    expect(pruned).toEqual([PRUNED_ACME]);

    const carried = JSON.stringify(pruned);
    for (const dropped of ["description", "knowledge", "release_date", "doc", "modalities", "family"]) {
      expect(carried).not.toContain(dropped);
    }
  });

  it("skips what cannot be named, rather than failing the whole list", () => {
    const pruned = pruneCatalog({
      acme: RAW_ACME,
      nameless: { name: "No Id", npm: "@ai-sdk/x", models: {} },
      broken: { id: "broken", name: "Broken", npm: "@ai-sdk/x", models: { "": { id: "" } } },
    });
    // A provider without identity is dropped; a provider whose junk models are
    // all dropped survives with none, which a compatible endpoint has anyway.
    expect(pruned.map((p) => p.id)).toEqual(["acme", "broken"]);
    expect(pruned.find((p) => p.id === "broken")?.models).toEqual([]);
  });

  it("turns a package name into the route the provider store speaks", () => {
    expect(routeOf("@ai-sdk/openai-compatible", null)).toBe("openai-compatible");
    expect(routeOf("@ai-sdk/anthropic", null)).toBe("anthropic");
  });
});

async function providers(): Promise<Array<{ name: string; npm: string; api: string | null }>> {
  const json = gunzipSync(await readFile("app/catalog/snapshot.json.gz")).toString("utf8");
  return (JSON.parse(json) as { providers: Array<{ name: string; npm: string; api: string | null }> })
    .providers;
}

describe("the route a catalogue entry takes", () => {
  it("does not move a single route that already resolved, because the cache is keyed on it", async () => {
    // The spec `openai:gpt-5` is the modelId a translation was cached under.
    // A route that changes name makes a paid-for book translate itself again.
    for (const provider of await providers()) {
      if (routeForPackage(provider.npm) === null) continue;
      if (!provider.npm.startsWith("@ai-sdk/")) continue;
      const legacy = provider.npm.slice("@ai-sdk/".length);
      if (legacy.includes("/")) continue; // never resolved: the regex refused it
      expect(routeOf(provider.npm, provider.api)).toBe(legacy);
    }
  });

  it("serves an unknown package through openai-compatible when the catalogue knows its address", () => {
    expect(routeOf("some-new-publisher", "https://example.test/v1")).toBe("openai-compatible");
  });

  it("says it cannot serve an unknown package with no address", () => {
    expect(routeOf("some-new-publisher", null)).toBeNull();
  });

  it("leaves exactly the providers with neither a compatible package nor an endpoint unserved", async () => {
    const unserved = (await providers())
      .filter((provider) => routeOf(provider.npm, provider.api) === null)
      .map((provider) => provider.name)
      .sort();

    expect(unserved).toEqual(["AIHubMix", "SAP AI Core", "Venice AI", "v0", "watsonx.ai"]);
  });
});

/** A catalogue as the search reads it: the date it was produced, and entries. */
const aCatalog = (providers: CatalogProvider[]) =>
  ({ at: "2026-08-27T00:00:00.000Z", providers });

describe("what an entry says about itself", () => {
  it("carries the name of the variable its key is usually in", () => {
    const [entry] = searchCatalog(aCatalog([
      { id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible",
        env: ["ACME_API_KEY"], api: "https://acme.test/v1", models: [] },
    ]), "acme");

    expect(entry!.envVar).toBe("ACME_API_KEY");
  });

  it("takes the first when a provider declares several", () => {
    // Google declares three. One name on a line is information; three is a
    // list nobody reads.
    const [entry] = searchCatalog(aCatalog([
      { id: "goog", name: "Goog", npm: "@ai-sdk/google",
        env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
        api: null, models: [] },
    ]), "goog");

    expect(entry!.envVar).toBe("GOOGLE_API_KEY");
  });

  it("says null when a provider declares none", () => {
    const [entry] = searchCatalog(aCatalog([
      { id: "bare", name: "Bare", npm: "@ai-sdk/openai-compatible",
        env: [], api: "https://bare.test/v1", models: [] },
    ]), "bare");

    expect(entry!.envVar).toBeNull();
  });
});

async function makePaths() {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-catalog-"));
  return { dir, bundled: join(dir, "snapshot.json.gz"), cache: join(dir, "catalog.json.gz") };
}

async function writeGz(path: string, value: unknown): Promise<void> {
  await writeFile(path, gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
}

/** A snapshot as `fetch-catalog.mjs` writes it. */
const bundled = (at: string) => ({ at, providers: [PRUNED_ACME] });

describe("reading the catalogue", () => {
  it("reads and decompresses the bundled snapshot", async () => {
    const paths = await makePaths();
    await writeGz(paths.bundled, bundled("2026-01-01T00:00:00Z"));

    const loaded = await readCatalog(paths);
    expect(loaded.catalog.at).toBe("2026-01-01T00:00:00Z");
    expect(loaded.catalog.providers).toEqual([PRUNED_ACME]);
    expect(loaded.bundled).toBe(true);
  });

  it("prefers a disk cache newer than the bundled snapshot", async () => {
    const paths = await makePaths();
    await writeGz(paths.bundled, bundled("2026-01-01T00:00:00Z"));
    await writeGz(paths.cache, {
      at: "2026-06-01T00:00:00Z", etag: '"v1"', providers: [PRUNED_ACME, PRUNED_ACME],
    });

    const loaded = await readCatalog(paths);
    expect(loaded.bundled).toBe(false);
    expect(loaded.catalog.providers).toHaveLength(2);
  });

  it("falls back to the bundled snapshot when the cache is older, as after an update", async () => {
    const paths = await makePaths();
    await writeGz(paths.bundled, bundled("2026-06-01T00:00:00Z"));
    await writeGz(paths.cache, { at: "2026-01-01T00:00:00Z", etag: '"v1"', providers: [] });

    const loaded = await readCatalog(paths);
    expect(loaded.bundled).toBe(true);
    expect(loaded.catalog.providers).toHaveLength(1);
  });

  it("serves the bundled snapshot when the cache cannot be read", async () => {
    const paths = await makePaths();
    await writeGz(paths.bundled, bundled("2026-01-01T00:00:00Z"));
    await writeFile(paths.cache, "not gzip at all");

    const loaded = await readCatalog(paths);
    expect(loaded.bundled).toBe(true);
    expect(loaded.catalog.providers).toHaveLength(1);
  });

  it("ships a real snapshot that is a valid catalogue", async () => {
    // The artifact is committed: this is the one test that would catch a
    // truncated or hand-mangled snapshot before a release ships it.
    const paths = { bundled: "app/catalog/snapshot.json.gz", cache: join(tmpdir(), "nowhere.gz") };
    const loaded = await readCatalog(paths);
    expect(loaded.bundled).toBe(true);
    expect(loaded.catalog.providers.length).toBeGreaterThan(100);
    expect(loaded.catalog.providers.flatMap((p) => p.models).length).toBeGreaterThan(1000);
  });
});

/** A `fetch` that answers from canned responses, so no test reaches the network. */
function canned(respond: typeof fetch): typeof fetch {
  return respond;
}

describe("enriching what the endpoint lists", () => {
  it("adds what the catalogue knows, and says null for what it does not", () => {
    // The endpoint is the truth about which models exist; the catalogue is
    // the truth about what they cost and hold. The second model is served but
    // unknown to the catalogue, and unknown means absent, never invented.
    const enriched = enrichModels(["acme-mini", "acme-other"], PRUNED_ACME);

    expect(enriched).toEqual([
      {
        id: "acme-mini",
        displayName: "Acme Mini",
        contextWindow: 128_000,
        priceIn: 0.5,
        priceOut: 2,
        capabilities: { toolCall: true, reasoning: false, structuredOutput: true, attachment: false },
      },
      {
        id: "acme-other",
        displayName: "acme-other",
        contextWindow: null,
        priceIn: null,
        priceOut: null,
        capabilities: null,
      },
    ]);
  });

  it("answers plain ids when there is no catalogue entry to enrich from", () => {
    expect(enrichModels(["acme-mini"], null)).toEqual([
      {
        id: "acme-mini", displayName: "acme-mini", contextWindow: null,
        priceIn: null, priceOut: null, capabilities: null,
      },
    ]);
  });
});

describe("refreshing the catalogue", () => {
  it("replaces the cache and changes the date when the network answers", async () => {
    const paths = await makePaths();
    await writeGz(paths.bundled, bundled("2026-01-01T00:00:00Z"));
    const body = JSON.stringify({ acme: RAW_ACME });

    const loaded = await refreshCatalog(paths, {
      fetch: canned(async () => new Response(body, { status: 200, headers: { etag: '"v2"' } })),
    });

    expect(loaded.bundled).toBe(false);
    expect(loaded.stale).toBe(false);
    expect(loaded.catalog.at).not.toBe("2026-01-01T00:00:00Z");
    expect(loaded.catalog.providers).toEqual([PRUNED_ACME]);

    // The cache is what a later start will read.
    const reread = await readCatalog(paths);
    expect(reread.bundled).toBe(false);
    expect(reread.catalog.providers).toEqual([PRUNED_ACME]);
  });

  it("is not an error to be offline: the snapshot answers, declared stale", async () => {
    const paths = await makePaths();
    await writeGz(paths.bundled, bundled("2026-01-01T00:00:00Z"));

    const loaded = await refreshCatalog(paths, {
      fetch: canned(async () => {
        throw new TypeError("fetch failed");
      }),
    });

    expect(loaded.catalog.at).toBe("2026-01-01T00:00:00Z");
    expect(loaded.bundled).toBe(true);
    expect(loaded.stale).toBe(true);
  });

  it("keeps what works when the answer is not a catalogue", async () => {
    const paths = await makePaths();
    await writeGz(paths.bundled, bundled("2026-01-01T00:00:00Z"));

    for (const body of ["not json {{{", "{}", "[]"]) {
      const loaded = await refreshCatalog(paths, {
        fetch: canned(async () => new Response(body, { status: 200 })),
      });
      expect(loaded.bundled).toBe(true);
      expect(loaded.stale).toBe(true);
      expect(loaded.catalog.providers).toEqual([PRUNED_ACME]);
    }

    // Nothing was written: the next start is exactly where this one began.
    const reread = await readCatalog(paths);
    expect(reread.bundled).toBe(true);
  });

  it("does not rewrite the cache on a 304, and asks with the ETag it holds", async () => {
    const paths = await makePaths();
    await writeGz(paths.bundled, bundled("2026-01-01T00:00:00Z"));
    const body = JSON.stringify({ acme: RAW_ACME });

    await refreshCatalog(paths, {
      fetch: canned(async () => new Response(body, { status: 200, headers: { etag: '"v1"' } })),
    });
    const before = await readFile(paths.cache);

    const asked: unknown[] = [];
    const loaded = await refreshCatalog(paths, {
      fetch: canned(async (input, init) => {
        asked.push(input, init?.headers);
        return new Response(null, { status: 304, headers: { etag: '"v1"' } });
      }),
    });

    expect(loaded.stale).toBe(false);
    expect(loaded.bundled).toBe(false);
    expect(asked).toEqual([CATALOG_URL, { "if-none-match": '"v1"' }]);
    expect(await readFile(paths.cache)).toEqual(before);
  });
});
