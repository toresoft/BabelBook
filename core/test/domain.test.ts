import { describe, expect, it } from "vitest";
import { voteDomain } from "../analyze/domain.ts";
import { FakeBackend } from "./fake/backend.ts";
import type { Glossary } from "../glossary/index.ts";
import type { TranslationUnit } from "../epub/index.ts";

const units: TranslationUnit[] = Array.from({ length: 60 }, (_, i) => ({
  id: `c1.xhtml#${i + 1}`, kind: "block", doc: "c1.xhtml", ordinal: i + 1,
  range: [i * 20, i * 20 + 11], source: `Sentence ${i + 1}`, raw: `Sentence ${i + 1}`,
  state: "translate",
}));

const glossary = (name: string, description: string): Glossary => ({
  name, version: 1, description, sourceLanguage: "en", targetLanguage: "it", terms: [],
});

const glossaries = [
  glossary("fantasy", "Epic fantasy with invented names and places"),
  glossary("tech", "Software manuals and developer tools"),
];

describe("voteDomain", () => {
  it("takes the majority of three independent samples", async () => {
    const verdict = await voteDomain({
      units, glossaries, backend: new FakeBackend(["fantasy", "fantasy", "tech"]),
    });

    expect(verdict).toMatchObject({ glossary: "fantasy", method: "majority" });
    expect(verdict.taxonomy).toEqual(["fantasy", "tech"]);
    expect(verdict.votes).toEqual(["fantasy", "fantasy", "tech"]);
  });

  it("abstains when there is no majority", async () => {
    const verdict = await voteDomain({
      units, glossaries, backend: new FakeBackend(["fantasy", "tech", "none"]),
    });
    expect(verdict).toMatchObject({ glossary: null, method: "abstained" });
  });

  it("abstains when the answer names a glossary that does not exist", async () => {
    const verdict = await voteDomain({
      units, glossaries, backend: new FakeBackend(["cooking", "cooking", "cooking"]),
    });
    expect(verdict).toMatchObject({ glossary: null, method: "abstained" });
  });

  it("records that no glossary applies, which is a decision and not a failure", async () => {
    const verdict = await voteDomain({
      units, glossaries, backend: new FakeBackend(["none", "none", "none"]),
    });
    expect(verdict).toMatchObject({ glossary: null, method: "none-applies" });
  });

  it("does not ask at all when there are no glossaries", async () => {
    const backend = new FakeBackend([]);
    const verdict = await voteDomain({ units, glossaries: [], backend });

    expect(verdict).toMatchObject({ method: "no-glossaries", glossary: null });
    expect(verdict.taxonomy).toEqual([]);
    expect(backend.prompts).toEqual([]);
  });

  it("offers each glossary by name and description, because the description is what decides", async () => {
    const backend = new FakeBackend(["fantasy", "fantasy", "fantasy"]);
    await voteDomain({ units, glossaries, backend });

    expect(backend.prompts[0]).toContain("fantasy");
    expect(backend.prompts[0]).toContain("Epic fantasy with invented names and places");
    expect(backend.prompts[0]).toContain("none");
  });

  it("reads an answer wrapped in punctuation, and ignores case", async () => {
    const verdict = await voteDomain({
      units, glossaries, backend: new FakeBackend(['"Fantasy."', "fantasy", "FANTASY"]),
    });
    expect(verdict.glossary).toBe("fantasy");
  });

  it("discards prose instead of hunting for a glossary name inside it", async () => {
    const verdict = await voteDomain({
      units, glossaries,
      backend: new FakeBackend(["this is not fantasy at all", "tech", "tech"]),
    });
    expect(verdict).toMatchObject({ glossary: "tech", method: "majority" });
  });

  it("stops on an abort signal instead of finishing the vote", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(voteDomain({
      units, glossaries, backend: new FakeBackend(["fantasy", "fantasy", "fantasy"]),
      signal: controller.signal,
    })).rejects.toThrow();
  });
});
