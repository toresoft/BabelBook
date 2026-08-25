import { describe, expect, it } from "vitest";
import { detectLanguage } from "../analyze/language.ts";
import { FakeBackend } from "./fake/backend.ts";
import type { TranslationUnit } from "../epub/index.ts";

const units: TranslationUnit[] = Array.from({ length: 30 }, (_, i) => ({
  id: `c1.xhtml#${i + 1}`, kind: "block", doc: "c1.xhtml", ordinal: i + 1,
  range: [i * 50, i * 50 + 43],
  source: "The quick brown fox jumps over the lazy dog",
  raw: "The quick brown fox jumps over the lazy dog",
  state: "translate",
}));

describe("detectLanguage", () => {
  it("does not call the model when the package declares a plausible language", async () => {
    const backend = new FakeBackend([]);
    const verdict = await detectLanguage({ declared: "en", units, backend });

    expect(verdict).toMatchObject({ language: "en", method: "declared", needsConfirmation: false });
    expect(backend.prompts).toEqual([]);
  });

  it("normalises a regional tag to its primary subtag", async () => {
    const verdict = await detectLanguage({ declared: "en-US", units, backend: new FakeBackend([]) });
    expect(verdict.language).toBe("en");
  });

  it("treats an undetermined declaration as no declaration at all", async () => {
    const backend = new FakeBackend(["en", "en", "en"]);
    const verdict = await detectLanguage({ declared: "und", units, backend });

    expect(verdict).toMatchObject({ language: "en", method: "voted" });
    expect(backend.prompts).toHaveLength(3);
  });

  it("votes when the package declares nothing", async () => {
    const verdict = await detectLanguage({
      declared: null, units, backend: new FakeBackend(["en", "en", "en"]),
    });
    expect(verdict).toMatchObject({ language: "en", method: "voted", needsConfirmation: false });
  });

  it("takes a majority, not unanimity", async () => {
    const verdict = await detectLanguage({
      declared: null, units, backend: new FakeBackend(["en", "en", "fr"]),
    });
    expect(verdict).toMatchObject({ language: "en", method: "voted" });
  });

  it("asks the user when a checked declaration is contradicted by the vote", async () => {
    const verdict = await detectLanguage({
      declared: "en", units: units.map((u) => ({ ...u, state: "translate" as const })),
      backend: new FakeBackend(["fr", "fr", "fr"]),
      verifyDeclared: true,
    });
    expect(verdict).toMatchObject({
      method: "conflict", declared: "en", voted: "fr", language: null, needsConfirmation: true,
    });
  });

  it("asks the user when there is no backend to vote with", async () => {
    const verdict = await detectLanguage({ declared: null, units, backend: null });
    expect(verdict).toMatchObject({ method: "no-backend", language: null, needsConfirmation: true });
  });

  it("abstains rather than guessing when the samples disagree", async () => {
    const verdict = await detectLanguage({
      declared: null, units, backend: new FakeBackend(["en", "fr", "de"]),
    });
    expect(verdict).toMatchObject({ method: "abstained", language: null, needsConfirmation: true });
  });

  it("ignores an answer that is not a language code, instead of reading a word out of it", async () => {
    const verdict = await detectLanguage({
      declared: null, units,
      backend: new FakeBackend(["I would say this text is in English.", "en", "en"]),
    });
    expect(verdict).toMatchObject({ language: "en", method: "voted" });
  });

  it("abstains when nothing it got back was a code", async () => {
    const verdict = await detectLanguage({
      declared: null, units,
      backend: new FakeBackend(["English", "definitely English", "English!"]),
    });
    expect(verdict.method).toBe("abstained");
  });

  it("puts the sampled text in the prompt, not the whole book", async () => {
    const backend = new FakeBackend(["en", "en", "en"]);
    await detectLanguage({ declared: null, units, backend });
    expect(backend.prompts[0]).toContain("The quick brown fox");
    expect(backend.prompts[0].length).toBeLessThan(4000);
  });

  it("stops on an abort signal instead of finishing the vote", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(detectLanguage({
      declared: null, units, backend: new FakeBackend(["en", "en", "en"]),
      signal: controller.signal,
    })).rejects.toThrow();
  });
});
