import gzip from "node:zlib";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json" with { type: "json" };
import itCatalogue from "../locales/it.json" with { type: "json" };
import { POPULAR } from "../main/catalog/popular.ts";

async function ids(): Promise<Set<string>> {
  const json = gzip.gunzipSync(await readFile("app/catalog/snapshot.json.gz")).toString("utf8");
  return new Set((JSON.parse(json) as { providers: Array<{ id: string }> }).providers.map((p) => p.id));
}

/**
 * The ten this application recommends.
 *
 * A recommendation is an opinion, and opinions age — no test can say whether
 * these are still good first choices. What a test can say is that they still
 * exist and still have their sentence, so a catalogue refresh cannot quietly
 * remove one from under the screen.
 */
describe("the recommended providers", () => {
  it("are all still in the catalogue", async () => {
    const known = await ids();
    expect(POPULAR.filter((id) => !known.has(id))).toEqual([]);
  });

  it("each carry a sentence, in both languages", () => {
    const missing: string[] = [];
    for (const id of POPULAR) {
      for (const [lang, catalogue] of [["it", itCatalogue], ["en", en]] as const) {
        const said = (catalogue as { popular?: Record<string, string> }).popular?.[id];
        if (said === undefined || said.trim() === "") missing.push(`${lang}: ${id}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
