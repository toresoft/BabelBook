import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIRM_KINDS } from "../shared/channels.ts";

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

  it("has a question, in every language, for every destructive act there is", async () => {
    const itKeys = keys(await load("it"));
    const enKeys = keys(await load("en"));

    // The main process assembles the confirmation dialogs from these keys: a
    // missing one is a question that renders as its own raw key, in a dialog
    // the operating system draws.
    const wanted = [
      ...CONFIRM_KINDS.map((kind) => `confirm.${kind}.message`),
      "confirm.deleteGlossary.messageNone",
      "confirm.cancel", "confirm.delete", "confirm.abandon",
    ];

    for (const key of wanted) {
      expect(itKeys, `it must define ${key}`).toContain(key);
      expect(enKeys, `en must define ${key}`).toContain(key);
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

const FAULTS = [
  "transient", "throttled", "exhausted", "config",
  "input", "refused", "defect", "cancelled",
];

const CODES = [
  "PROVIDER_UNREACHABLE", "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED",
  "PROVIDER_OUT_OF_CREDIT", "PROVIDER_UNAUTHORIZED", "PROVIDER_SERVER_ERROR",
  "PROVIDER_UNKNOWN", "MODEL_NOT_FOUND", "CONTEXT_EXCEEDED", "RESPONSE_UNUSABLE",
  "SOURCE_MISSING", "DISK_FULL", "PATH_NOT_WRITABLE", "DATABASE_BUSY",
  "NO_TRANSLATABLE_CONTENT",
  "PROVIDER_REFUSED_SHAPE", "PROVIDER_REFUSED_REQUEST",
  "COMPOSE_NO_PACKAGE", "COMPOSE_NO_CACHE_KEY", "GATE_REFUSED",
  "ENGINE_BUSY", "GATE_OPEN", "NO_LANGUAGE", "SOURCE_CHANGED",
];

const LOG_CODES = [
  "provider-retry", "provider-recovered", "provider-slow",
  "run-paused", "chunk-failed", "unit-fell-back", "shape-refused", "html-media-type",
];

import italiano from "../locales/it.json" with { type: "json" };
import english from "../locales/en.json" with { type: "json" };

describe.each([["it", italiano], ["en", english]] as [string, Record<string, any>][])("the %s catalogue", (_language, catalogue) => {
  /**
   * The floor under every unnamed code. If a fault had no sentence, an error
   * nobody catalogued would print its bare identifier in the middle of an
   * Italian paragraph — which is what it did before.
   */
  it("has a sentence and an advice for every fault", () => {
    for (const fault of FAULTS) {
      expect(catalogue.faults?.[fault]?.body, fault).toBeTruthy();
      expect(catalogue.faults?.[fault]?.hint, fault).toBeTruthy();
    }
  });

  it("names every code the classifiers can produce", () => {
    for (const code of CODES) expect(catalogue.codes?.[code], code).toBeTruthy();
  });

  it("names every line the log can write", () => {
    for (const code of LOG_CODES) expect(catalogue.codes?.[code], code).toBeTruthy();
  });

  it("has a title for a run that paused as well as one that failed", () => {
    expect(catalogue.alerts?.paused).toBeTruthy();
    expect(catalogue.alerts?.failed).toBeTruthy();
  });

  /** The Registro's retry line is useless without its numbers. */
  it("interpolates the retry line", () => {
    for (const token of ["{{attempt}}", "{{max}}", "{{seconds}}"]) {
      expect(catalogue.codes["provider-retry"]).toContain(token);
    }
  });
});
