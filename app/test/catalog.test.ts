import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pruneCatalog, routeOf, type CatalogProvider } from "../main/catalog/shape.ts";
import { CATALOG_URL, readCatalog, refreshCatalog } from "../main/catalog/load.ts";

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
    expect(routeOf("@ai-sdk/openai-compatible")).toBe("openai-compatible");
    expect(routeOf("@ai-sdk/anthropic")).toBe("anthropic");
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
