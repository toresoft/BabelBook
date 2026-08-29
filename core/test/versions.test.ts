import { describe, expect, it } from "vitest";
import { cacheKey, CONTEXT_VERSION, PROMPT_VERSION } from "../translate/versions.ts";

const base = {
  sourceSha256: "sha-of-the-book",
  modelId: "acme:m1",
  reasoning: false,
  sourceLanguage: "en",
  targetLanguage: "it",
  glossaries: ["fantasy@2"],
};

describe("cacheKey", () => {
  it("does not depend on the order the glossaries arrive in", () => {
    expect(cacheKey({ ...base, glossaries: ["fantasy@2", "tech@1"] }))
      .toBe(cacheKey({ ...base, glossaries: ["tech@1", "fantasy@2"] }));
  });

  it("changes when a glossary version changes", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, glossaries: ["fantasy@3"] }));
  });

  it("changes when a glossary is added or removed", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, glossaries: ["fantasy@2", "tech@1"] }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, glossaries: [] }));
  });

  it("changes when the model changes", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, modelId: "acme:m2" }));
  });

  it("changes when either language changes", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, targetLanguage: "fr" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, sourceLanguage: "de" }));
  });

  it("changes when the prompt or the context policy changes", () => {
    const now = cacheKey(base);
    expect(now).not.toBe(cacheKey(base, { prompt: PROMPT_VERSION + 1, context: CONTEXT_VERSION }));
    expect(now).not.toBe(cacheKey(base, { prompt: PROMPT_VERSION, context: CONTEXT_VERSION + 1 }));
  });

  it("does not reuse work made under the contract that never stated a format", () => {
    // Version 1 asked the model to answer "in the format you are given" and
    // named none of it. Everything translated under it is unusable, and a key
    // that had not moved would hand those fallbacks back as finished work.
    expect(cacheKey(base)).not.toBe(cacheKey(base, { prompt: 1, context: CONTEXT_VERSION }));
  });

  it("cannot be forged by a glossary name that looks like two", () => {
    expect(cacheKey({ ...base, glossaries: ['a@1","b@1'] }))
      .not.toBe(cacheKey({ ...base, glossaries: ["a@1", "b@1"] }));
  });

  it("is stable across calls, and looks like a digest", () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
    expect(cacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
