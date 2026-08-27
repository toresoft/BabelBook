import gzip from "node:zlib";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PROVIDER_PACKAGES, routeForPackage } from "../engine/backends/registry.ts";

/** Catalogue packages that cannot enter the native registry on AI SDK 7. */
const OLD_SPEC = [
  "@ai-sdk/vercel",
  "@jerome-benoit/sap-ai-provider-v2",
  "@aihubmix/ai-sdk-provider",
  "merge-gateway-ai-sdk-provider",
  "watsonx-ai-provider",
  "venice-ai-sdk-provider",
];

async function catalogue(): Promise<Array<{ npm: string; api: string | null }>> {
  const bytes = await readFile("app/catalog/snapshot.json.gz");
  const json = gzip.gunzipSync(bytes).toString("utf8");
  return (JSON.parse(json) as { providers: Array<{ npm: string; api: string | null }> }).providers;
}

/**
 * The one place a package name is written.
 *
 * Everything else asks the registry. These tests hold the two properties that
 * make that safe: every package it names is really installed and really
 * exports a provider factory, and every package the catalogue names is either
 * in it or knowingly out of it.
 */
describe("the provider registry", () => {
  it("loads every package it names, and each exports a factory", async () => {
    const failures: string[] = [];

    for (const [route, entry] of Object.entries(PROVIDER_PACKAGES)) {
      try {
        const module = (await entry.load()) as Record<string, unknown>;
        const factories = Object.keys(module)
          .filter((key) => key.startsWith("create") && typeof module[key] === "function");
        if (factories.length === 0) failures.push(`${route} (${entry.specifier}): no create* export`);
      } catch (error) {
        failures.push(`${route} (${entry.specifier}): ${(error as Error).message}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("names a route for every compatible package, and none for packages on the old spec", async () => {
    const unmapped = new Set<string>();
    for (const provider of await catalogue()) {
      if (routeForPackage(provider.npm) === null) unmapped.add(provider.npm);
    }

    expect([...unmapped].sort()).toEqual([...OLD_SPEC].sort());
  });
});
