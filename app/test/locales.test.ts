import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const load = async (language: string) =>
  JSON.parse(await readFile(`app/locales/${language}.json`, "utf8")) as Record<string, unknown>;

function keys(object: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(object).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? keys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`]);
}

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (/\.(ts|html)$/.test(entry.name) && !entry.name.endsWith(".spec.ts")) out.push(path);
  }
  return out;
}

/**
 * The net under the catalogues.
 *
 * Localisation rots quietly: a feature adds a key to one language, a template
 * uses a key nobody defined, and both look fine until someone reads the
 * interface in the other language. These four tests are what turn that into a
 * failure at the moment it is introduced.
 */
describe("catalogues", () => {
  it("has the same keys in every language", async () => {
    expect(keys(await load("it"))).toEqual(keys(await load("en")));
  });

  it("has a key for every code the core can emit", async () => {
    const defined = keys(await load("it"));
    for (const code of [
      "unit-fell-back", "chunk-exhausted", "unsupported-encoding",
      "unreliable-range", "document-skipped", "abstained",
    ]) {
      expect(defined).toContain(`codes.${code}`);
    }
  });

  it("has a name for every state a project can be in", async () => {
    const defined = keys(await load("it"));
    for (const state of [
      "new", "needs-language", "ready", "running", "waiting-terms",
      "waiting-code", "composing", "paused", "done", "incomplete", "failed",
    ]) {
      expect(defined).toContain(`state.${state}`);
    }
  });

  it("uses no key the catalogues do not define", async () => {
    const defined = new Set(keys(await load("it")));
    const used = new Set<string>();

    for (const file of await sources("app/renderer/src")) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/(?:transloco[|:]\s*|\bt\(\s*)['"]([a-z][\w.-]*)['"]/gi)) {
        used.add(match[1]);
      }
    }

    // A key ending in a dot is a prefix the template completes at runtime —
    // `t('state.' + project.state)`. The exact key cannot be known here, but
    // the namespace can: a prefix nothing is defined under is a typo that
    // would render as raw text for every value it takes.
    const missing = [...used].filter((key) => key.endsWith(".")
      ? ![...defined].some((known) => known.startsWith(key))
      : !defined.has(key));

    expect(missing).toEqual([]);
  });
});
