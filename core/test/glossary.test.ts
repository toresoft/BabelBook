import { describe, expect, it } from "vitest";
import {
  glossaryIdentity, GlossaryError, parseGlossary, serializeGlossary, supportsLanguages,
} from "../glossary/index.ts";

const source = `---
name: fantasy
version: 2
description: Epic fantasy with invented names and places
sourceLanguage: en
targetLanguage: it
---

| source | target | rule | note |
|---|---|---|---|
| Rivendell |  | dnt | place name |
| dwarf | nano | must | never "nanetto" |
`;

describe("parseGlossary", () => {
  it("reads the frontmatter and the term table", () => {
    const glossary = parseGlossary(source);
    expect(glossary).toMatchObject({
      name: "fantasy", version: 2, sourceLanguage: "en", targetLanguage: "it",
      description: "Epic fantasy with invented names and places",
    });
    expect(glossary.terms).toEqual([
      { source: "Rivendell", rule: "dnt", note: "place name", origin: "glossary" },
      { source: "dwarf", target: "nano", rule: "must", note: `never "nanetto"`, origin: "glossary" },
    ]);
  });

  it("round-trips through serialize", () => {
    expect(parseGlossary(serializeGlossary(parseGlossary(source)))).toEqual(parseGlossary(source));
  });

  it("keeps a pipe inside a note instead of splitting the row on it", () => {
    const withPipe = source.replace("place name", String.raw`either \| or`);
    expect(parseGlossary(withPipe).terms[0].note).toBe("either | or");
    expect(parseGlossary(serializeGlossary(parseGlossary(withPipe))).terms[0].note)
      .toBe("either | or");
  });

  it("accepts a glossary with no terms yet", () => {
    expect(parseGlossary(source.split("| source |")[0]).terms).toEqual([]);
  });

  it("refuses a rule it does not know", () => {
    expect(() => parseGlossary(source.replace("| dnt |", "| maybe |")))
      .toThrow(/UNKNOWN_RULE/);
  });

  it("refuses a must rule with nothing to render it as", () => {
    expect(() => parseGlossary(source.replace("| dwarf | nano | must |", "| dwarf |  | must |")))
      .toThrow(/MISSING_TARGET/);
  });

  it("refuses a glossary without a version", () => {
    expect(() => parseGlossary(source.replace("version: 2\n", ""))).toThrow(GlossaryError);
  });

  it("refuses a glossary without frontmatter at all", () => {
    expect(() => parseGlossary("| source | target | rule | note |")).toThrow(/NO_FRONTMATTER/);
  });
});

describe("identity", () => {
  it("sorts, so the same set always reads the same", () => {
    const glossary = parseGlossary(source);
    expect(glossaryIdentity([{ ...glossary, name: "tech", version: 1 }, glossary]))
      .toEqual(["fantasy@2", "tech@1"]);
  });
});

describe("supportsLanguages", () => {
  it("matches by primary subtag, so en-US is en", () => {
    const glossary = parseGlossary(source);
    expect(supportsLanguages(glossary, "en-US", "it")).toBe(true);
    expect(supportsLanguages(glossary, "en", "it-IT")).toBe(true);
    expect(supportsLanguages(glossary, "fr", "it")).toBe(false);
  });
});

describe("the format the prototype actually wrote", () => {
  const real = `---
name: angular
description: >
  Angular and TypeScript: components, signals, dependency injection,
  templates, the type system.
languages: ["en>it"]
version: 1
layer: domain
approved: true
license: CC-BY-4.0
---

| source | target | rule | sense | note |
|---|---|---|---|---|
| signal | signal | dnt | the Angular reactive primitive | not the general "segnale" |
| standalone | standalone | dnt | the component flag | |
`;

  it("reads a folded description as one line", () => {
    expect(parseGlossary(real).description)
      .toBe("Angular and TypeScript: components, signals, dependency injection, templates, the type system.");
  });

  it("reads the language pair from the languages list", () => {
    expect(parseGlossary(real)).toMatchObject({ sourceLanguage: "en", targetLanguage: "it" });
  });

  it("ignores frontmatter keys it has no use for", () => {
    expect(parseGlossary(real).name).toBe("angular");
  });

  it("maps columns by their header, so an extra one shifts nothing", () => {
    const [signal] = parseGlossary(real).terms;
    expect(signal).toMatchObject({
      source: "signal", target: "signal", rule: "dnt", note: `not the general "segnale"`,
    });
  });

  it("reads a preferred rendering as its own rule, not as an obligation", () => {
    const withPrefer = real.replace(
      "| standalone | standalone | dnt | the component flag | |",
      "| component | componente | prefer | an Angular component | |");
    const [, component] = parseGlossary(withPrefer).terms;
    expect(component).toMatchObject({ source: "component", target: "componente", rule: "prefer" });
  });

  it("names the rule it does not know instead of guessing at it", () => {
    expect(() => parseGlossary(real.replace("| dnt | the component flag", "| maybe | the component flag")))
      .toThrow(/UNKNOWN_RULE.*maybe/s);
  });

  it("refuses a preferred rendering with nothing to render as", () => {
    expect(() => parseGlossary(real.replace("| standalone | standalone | dnt |", "| standalone |  | prefer |")))
      .toThrow(/MISSING_TARGET/);
  });
});
