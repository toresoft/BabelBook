import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import {
  installCatalog, parseImportedCatalog, readCatalog, refreshCatalog,
} from "../main/catalog/load.ts";
import type { CatalogProvider } from "../main/catalog/shape.ts";
import { createProvider, readKey, refreshCatalogMetadata } from "../main/providers/store.ts";

/**
 * The update pipeline: what a successful refresh replaces, what a failed one
 * must not touch, and what it means to carry a catalogue on a USB stick.
 */

const ACME: CatalogProvider = {
  id: "acme", name: "Acme", npm: "@ai-sdk/acme", env: ["ACME_API_KEY"],
  api: "https://api.acme.test/v1",
  models: [{
    id: "m1", name: "M1",
    cost: { input: 1, output: 5, cacheRead: null, cacheWrite: null },
    limit: { context: 128_000, output: 8_192 },
    toolCall: true, reasoning: false, structuredOutput: true, attachment: false,
  }],
};

async function paths() {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-catalog-update-"));
  return { dir, bundled: join(dir, "snapshot.json.gz"), cache: join(dir, "catalog.json.gz") };
}

async function writeGz(path: string, value: unknown): Promise<void> {
  await writeFile(path, gzipSync(Buffer.from(JSON.stringify(value), "utf8")));
}

const db = () => {
  const d = openDatabase(":memory:");
  migrate(d, loadMigrations("app/main/db/migrations"));
  return d;
};

const crypto = {
  isAvailable: () => true,
  encrypt: (plain: string) => Buffer.from(Buffer.from(`enc:${plain}`, "utf8").toString("base64"), "utf8"),
  decrypt: (blob: Buffer) => Buffer.from(blob.toString("utf8"), "base64").toString("utf8").replace(/^enc:/, ""),
};

const canned = (respond: typeof fetch): typeof fetch => respond;

describe("importing a catalogue from a file", () => {
  it("accepts the snapshot format, dated as it is", () => {
    const parsed = parseImportedCatalog(
      JSON.stringify({ at: "2026-05-01T00:00:00Z", providers: [ACME] }));
    expect(parsed).toEqual({ at: "2026-05-01T00:00:00Z", providers: [ACME] });
  });

  it("accepts the raw api.json, pruned and dated by the import", () => {
    // The file someone carries on a USB stick is most naturally the one the
    // network hands out. It carries no date, so the import moment is the only
    // honest one to stamp on it.
    const raw = JSON.stringify({
      acme: { id: "acme", name: "Acme", npm: "@ai-sdk/acme", models: { m1: { id: "m1" } } },
    });
    const parsed = parseImportedCatalog(raw, () => new Date("2026-08-01T00:00:00Z"));
    expect(parsed.at).toBe("2026-08-01T00:00:00.000Z");
    expect(parsed.providers).toHaveLength(1);
  });

  it("refuses a file that is not a catalogue, with a code", () => {
    for (const junk of ["not json {{{", "[]", '{"at": "yesterday", "providers": "many"}', "{}"]) {
      // The refusal is synchronous: nothing is read, nothing is written.
      let failure: { code?: string } | null = null;
      try {
        parseImportedCatalog(junk, () => new Date());
      } catch (error) {
        failure = error as { code?: string };
      }
      expect(failure).toMatchObject({ code: "BAD_CATALOG" });
    }
  });

  it("installs what was imported even when it is older, and the state says so", async () => {
    const p = await paths();
    await writeGz(p.bundled, { at: "2026-08-01T00:00:00Z", providers: [ACME] });
    const older = { at: "2026-01-01T00:00:00Z", providers: [ACME, ACME] };

    await installCatalog(p, older);

    // A user's choice outranks the shipping snapshot, whichever is newer: the
    // date line then declares what is in use, which is the whole point.
    const loaded = await readCatalog(p);
    expect(loaded.bundled).toBe(false);
    expect(loaded.catalog.at).toBe("2026-01-01T00:00:00Z");
    expect(loaded.catalog.providers).toHaveLength(2);
  });

  it("leaves the working cache in place when a file is refused", async () => {
    const p = await paths();
    await writeGz(p.bundled, { at: "2026-08-01T00:00:00Z", providers: [ACME] });
    await installCatalog(p, { at: "2026-08-02T00:00:00Z", providers: [ACME] });
    const before = await readFile(p.cache);

    expect(() => parseImportedCatalog("not a catalogue")).toThrow(/BAD_CATALOG/);
    expect(await readFile(p.cache)).toEqual(before);
  });
});

describe("the refresh pipeline", () => {
  it("replaces the cache, changes the date, and reprices bound providers", async () => {
    const p = await paths();
    await writeGz(p.bundled, { at: "2026-01-01T00:00:00Z", providers: [ACME] });
    const d = db();
    const provider = createProvider(d, crypto, {
      name: "Acme", route: "acme", baseUrl: null, headers: {}, options: {},
      catalogId: "acme", catalogAt: "2026-01-01T00:00:00Z", apiKey: "sk-secret",
      models: [{
        id: "m1", displayName: "m1", contextWindow: null, priceIn: null, priceOut: null,
        capabilities: null, reasoningEnabled: null,
      }],
    });

    // The network now says the model costs twice as much as it did.
    const dearer: CatalogProvider = {
      ...ACME,
      models: [{ ...ACME.models[0]!, cost: { input: 2, output: 10, cacheRead: null, cacheWrite: null } }],
    };
    const updated = await refreshCatalog(p, {
      fetch: canned(async () => new Response(
        JSON.stringify({ acme: { ...dearer, models: { m1: { ...dearer.models[0]! } } } }),
        { status: 200, headers: { etag: '"v2"' } },
      )),
    });

    expect(updated.changed).toBe(true);
    expect(updated.bundled).toBe(false);
    expect(updated.catalog.at).not.toBe("2026-01-01T00:00:00Z");

    // What the main process does when the cache changed: the bound providers
    // take the new prices, keep their key, and carry the new date.
    refreshCatalogMetadata(d, updated.catalog);
    const model = d.prepare(
      "SELECT price_in FROM provider_model WHERE provider_id = ? AND model_id = 'm1'",
    ).get(provider.id) as { price_in: number };
    const stamp = d.prepare("SELECT catalog_at FROM provider WHERE id = ?")
      .get(provider.id) as { catalog_at: string };
    expect(model.price_in).toBe(2);
    expect(stamp.catalog_at).toBe(updated.catalog.at);
    expect(readKey(d, crypto, provider.id)).toBe("sk-secret");
  });

  it("changes nothing when the network cannot be reached, and says so by not changing", async () => {
    const p = await paths();
    await writeGz(p.bundled, { at: "2026-01-01T00:00:00Z", providers: [ACME] });

    const failed = await refreshCatalog(p, {
      fetch: canned(async () => {
        throw new TypeError("fetch failed");
      }),
    });

    expect(failed.changed).toBe(false);
    expect(failed.stale).toBe(true);
    expect(failed.catalog.at).toBe("2026-01-01T00:00:00Z");
    // Nothing was written where the next start would read it.
    expect(await readCatalog(p)).toMatchObject({ bundled: true });
  });

  it("notes the moment of a 304 without rewriting the cache", async () => {
    const p = await paths();
    await writeGz(p.bundled, { at: "2026-01-01T00:00:00Z", providers: [ACME] });
    const body = JSON.stringify({ acme: ACME });

    await refreshCatalog(p, {
      fetch: canned(async () => new Response(body, { status: 200, headers: { etag: '"v1"' } })),
    });
    const cacheBefore = await readFile(p.cache);

    const notModified = await refreshCatalog(p, {
      fetch: canned(async () => new Response(null, { status: 304 })),
    });

    expect(notModified.changed).toBe(false);
    expect(notModified.stale).toBe(false);
    expect(await readFile(p.cache)).toEqual(cacheBefore);

    // Production break: the check is recorded on disk and reaches nobody.
    //
    // Recorded next to the cache rather than inside it, so a 304 does not
    // rewrite four megabytes — and handed back, because a catalogue produced
    // three weeks ago and confirmed unchanged a minute ago is current, and the
    // date alone would call it stale.
    expect(Number.isNaN(Date.parse(notModified.checkedAt ?? ""))).toBe(false);

    // And it survives the process that wrote it: the next start reads it back.
    expect((await readCatalog(p)).checkedAt).toBe(notModified.checkedAt);
  });

  it("has nothing to report before the network has ever answered", async () => {
    const p = await paths();
    await writeGz(p.bundled, { at: "2026-01-01T00:00:00.000Z", providers: [ACME] });

    // Null, not the moment of asking: never confirmed is a different fact from
    // confirmed long ago.
    expect((await readCatalog(p)).checkedAt).toBeNull();
  });
});

describe("a server that says nothing", () => {
  // Production break: the refresh the interface awaits waits for minutes.
  it("gives up rather than holding the button that asked", async () => {
    const p = await paths();
    await writeGz(p.bundled, { at: "2026-01-01T00:00:00.000Z", providers: [ACME] });

    // What a hanging server looks like from here: the connection is accepted,
    // nothing comes back, and only the abort ends it.
    const hangs = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const started = Date.now();
    const loaded = await refreshCatalog(p, { fetch: hangs, timeoutMs: 40 });

    expect(loaded.stale).toBe(true);
    expect(loaded.changed).toBe(false);
    // The catalogue that already worked keeps answering.
    expect(loaded.catalog.providers).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
