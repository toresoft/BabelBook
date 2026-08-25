import { describe, expect, it } from "vitest";
import { planChunks } from "../translate/plan.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (
  n: number,
  state: TranslationUnit["state"] = "translate",
  text = `Sentence ${n}`,
  doc = "c1.xhtml",
): TranslationUnit => ({
  id: `${doc}#${n}`, kind: "block", doc, ordinal: n,
  range: [n * 1000, n * 1000 + text.length], source: text, raw: text, state,
});

const languages = { sourceLanguage: "en", targetLanguage: "it" };
const ids = (chunks: ReturnType<typeof planChunks>) => chunks.flatMap((c) => c.units.map((u) => u.id));

describe("planChunks", () => {
  it("only plans work units, but keeps the others as context", () => {
    const chunks = planChunks({ units: [unit(1), unit(2, "code", "x = 1"), unit(3)], ...languages });

    expect(ids(chunks)).toEqual(["c1.xhtml#1", "c1.xhtml#3"]);
    expect(chunks[0].context.interleaved).toEqual(["x = 1"]);
  });

  it("plans a suspected code unit, which is still work", () => {
    expect(ids(planChunks({ units: [unit(1, "maybe-code")], ...languages }))).toEqual(["c1.xhtml#1"]);
  });

  it("splits on the character budget", () => {
    const units = Array.from({ length: 20 }, (_, i) => unit(i + 1, "translate", "x".repeat(500)));
    const chunks = planChunks({ units, ...languages, maxCharsPerChunk: 2000 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.units.reduce((n, u) => n + u.source.length, 0)).toBeLessThanOrEqual(2000);
    }
  });

  it("gives a single oversized unit a chunk of its own instead of dropping it", () => {
    const chunks = planChunks({
      units: [unit(1, "translate", "y".repeat(9000))], ...languages, maxCharsPerChunk: 2000,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].units).toHaveLength(1);
  });

  it("skips what is already done, and still uses it as context", () => {
    const chunks = planChunks({
      units: [unit(1), unit(2), unit(3)], ...languages, done: new Set(["c1.xhtml#2"]),
    });

    expect(ids(chunks)).toEqual(["c1.xhtml#1", "c1.xhtml#3"]);
    expect(chunks[0].context.interleaved).toEqual(["Sentence 2"]);
  });

  it("plans nothing when everything is done", () => {
    expect(planChunks({ units: [unit(1)], ...languages, done: new Set(["c1.xhtml#1"]) })).toEqual([]);
  });

  it("never crosses a document boundary inside a chunk", () => {
    const chunks = planChunks({
      units: [unit(1), unit(1, "translate", "Sentence 1", "c2.xhtml")], ...languages,
    });

    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(new Set(chunk.units.map((u) => u.doc)).size).toBe(1);
    }
  });

  it("takes context only from the unit's own document", () => {
    const chunks = planChunks({
      units: [unit(1), unit(2), unit(1, "translate", "Elsewhere", "c2.xhtml")], ...languages,
    });

    const second = chunks.find((c) => c.units[0].doc === "c2.xhtml")!;
    expect([...second.context.before, ...second.context.after].join(" ")).not.toContain("Sentence");
  });

  it("numbers the chapters, so the model knows where it is", () => {
    const chunks = planChunks({
      units: [unit(1), unit(1, "translate", "Two", "c2.xhtml")], ...languages,
    });

    expect(chunks[0].context.chapter).toEqual({ doc: "c1.xhtml", position: 1, total: 2 });
    expect(chunks[1].context.chapter).toEqual({ doc: "c2.xhtml", position: 2, total: 2 });
  });

  it("carries the book description and summary into every chunk", () => {
    const chunks = planChunks({
      units: [unit(1), unit(2)], ...languages,
      description: "A trilogy", bookSummary: "Frodo walks", maxCharsPerChunk: 10,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.context).toMatchObject({ description: "A trilogy", bookSummary: "Frodo walks" });
    }
  });

  it("keeps the window from running off either end of the document", () => {
    const chunks = planChunks({ units: [unit(1)], ...languages, contextWindow: 5 });
    expect(chunks[0].context).toMatchObject({ before: [], after: [], interleaved: [] });
  });
});
