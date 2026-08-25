import { describe, expect, it } from "vitest";
import { translateChunk, translateUnits } from "../translate/engine.ts";
import { FakeBackend } from "./fake/backend.ts";
import { FakeStore } from "./fake/store.ts";
import type { Chunk } from "../translate/plan.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n * 100, n * 100 + source.length], source, raw: source, state: "translate",
});

const chunk = (units: TranslationUnit[]): Chunk => ({
  units,
  context: {
    sourceLanguage: "en", targetLanguage: "it", before: [], after: [], interleaved: [],
    chapter: { doc: "c1.xhtml", position: 1, total: 1 },
  },
});

const ok = (body: string, count: number) => `UNITS ${count}\n${body}\nEND`;

describe("translateChunk", () => {
  it("accepts a good answer in one attempt", async () => {
    const out = await translateChunk({
      chunk: chunk([unit(1, "One"), unit(2, "Two")]), terms: [],
      backend: new FakeBackend([ok("[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue", 2)]),
    });

    expect(out.attempts).toBe(1);
    expect(out.translated.get("c1.xhtml#2")).toBe("Due");
    expect(out.fellBack).toEqual([]);
  });

  it("resends only the rejected unit, with the diagnosis", async () => {
    const backend = new FakeBackend([
      ok("[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\n", 2),
      ok("[u:c1.xhtml#2]\nDue", 1),
    ]);
    const out = await translateChunk({ chunk: chunk([unit(1, "One"), unit(2, "Two")]), terms: [], backend });

    expect(out.attempts).toBe(2);
    expect(out.translated.size).toBe(2);
    expect(backend.prompts[1]).toContain("c1.xhtml#2");
    expect(backend.prompts[1]).not.toContain("[u:c1.xhtml#1]");
    expect(backend.prompts[1]).toContain("empty-text");
  });

  it("falls a unit back to source when the attempts run out, and says why", async () => {
    const bad = ok("[u:c1.xhtml#1]\n", 1);
    const out = await translateChunk({
      chunk: chunk([unit(1, "One")]), terms: [], backend: new FakeBackend([bad, bad, bad]),
    });

    expect(out.translated.size).toBe(0);
    expect(out.fellBack).toEqual([{ unitId: "c1.xhtml#1", reason: "empty-text" }]);
    expect(out.attempts).toBe(3);
  });

  it("keeps asking for less when the answer was truncated", async () => {
    const backend = new FakeBackend((call) =>
      call.prompt.includes("UNITS 2")
        ? { text: "UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDu", tokensIn: 1, tokensOut: 1, finishReason: "length" as const }
        : { text: ok("[u:c1.xhtml#2]\nDue", 1), tokensIn: 1, tokensOut: 1, finishReason: "stop" as const });

    const out = await translateChunk({ chunk: chunk([unit(1, "One"), unit(2, "Two")]), terms: [], backend });
    expect(out.translated.size).toBe(2);
  });

  it("counts the tokens every attempt cost, not only the last", async () => {
    const backend = new FakeBackend((call) => ({
      text: call.prompt.includes("empty-text") ? ok("[u:c1.xhtml#1]\nUno", 1) : ok("[u:c1.xhtml#1]\n", 1),
      tokensIn: 10, tokensOut: 5, finishReason: "stop" as const,
    }));
    const out = await translateChunk({ chunk: chunk([unit(1, "One")]), terms: [], backend });

    expect(out.tokensIn).toBe(20);
    expect(out.tokensOut).toBe(10);
  });

  it("sends only the terms the chunk contains", async () => {
    const backend = new FakeBackend([ok("[u:c1.xhtml#1]\nVerso Rivendell", 1)]);
    await translateChunk({
      chunk: chunk([unit(1, "To Rivendell")]), backend,
      terms: [
        { source: "Rivendell", rule: "dnt", origin: "glossary" },
        { source: "Mordor", rule: "dnt", origin: "glossary" },
      ],
    });

    expect(backend.prompts[0]).toContain("Rivendell");
    expect(backend.prompts[0]).not.toContain("Mordor");
  });

  it("stops on an abort signal instead of finishing the chunk", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(translateChunk({
      chunk: chunk([unit(1, "One")]), terms: [],
      backend: new FakeBackend([ok("[u:c1.xhtml#1]\nUno", 1)]), signal: controller.signal,
    })).rejects.toThrow();
  });
});

describe("translateUnits", () => {
  const run = (units: TranslationUnit[], backend: FakeBackend, store = new FakeStore(units)) =>
    translateUnits({
      units, store, backend, progress: { report() {} }, cacheKey: "k1",
      sourceLanguage: "en", targetLanguage: "it", concurrency: 1,
    });

  it("writes each unit as soon as it is confirmed, so a pause costs nothing", async () => {
    const store = new FakeStore();
    const units = [unit(1, "One"), unit(2, "Two")];
    await run(units, new FakeBackend([ok("[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue", 2)]), store);

    expect((await store.translations("k1")).size).toBe(2);
  });

  it("skips what the cache already holds under the same key", async () => {
    const units = [unit(1, "One"), unit(2, "Two")];
    const store = new FakeStore(units);
    await store.putTranslation({
      unitId: "c1.xhtml#1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated",
    });
    const backend = new FakeBackend([ok("[u:c1.xhtml#2]\nDue", 1)]);
    await run(units, backend, store);

    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).not.toContain("[u:c1.xhtml#1]");
  });

  it("does not skip work held under another key", async () => {
    const units = [unit(1, "One")];
    const store = new FakeStore(units);
    await store.putTranslation({
      unitId: "c1.xhtml#1", text: "Autre", cacheKey: "k2", attempts: 1, outcome: "translated",
    });
    const backend = new FakeBackend([ok("[u:c1.xhtml#1]\nUno", 1)]);
    await run(units, backend, store);

    expect(backend.prompts).toHaveLength(1);
  });

  it("records a fallback as a degradation event", async () => {
    const store = new FakeStore();
    const bad = ok("[u:c1.xhtml#1]\n", 1);
    await run([unit(1, "One")], new FakeBackend([bad, bad, bad]), store);

    const event = store.events.find((e) => e.code === "unit-fell-back");
    expect(event?.severity).toBe("degradation");
    expect(event?.payload).toMatchObject({ unitId: "c1.xhtml#1" });
  });

  it("counts a translation identical to the source instead of hiding it", async () => {
    const summary = await run([unit(1, "Frodo")], new FakeBackend([ok("[u:c1.xhtml#1]\nFrodo", 1)]));

    expect(summary.units.identical).toBe(1);
    expect(summary.units.translated).toBe(1);
  });

  it("counts what nobody translates, by state", async () => {
    const units = [
      unit(1, "One"),
      { ...unit(2, "x = 1"), state: "code" as const },
      { ...unit(3, "Brand"), state: "translate-no" as const },
    ];
    const summary = await run(units, new FakeBackend([ok("[u:c1.xhtml#1]\nUno", 1)]));

    expect(summary.units.total).toBe(3);
    expect(summary.notTranslated).toMatchObject({ code: 1, "translate-no": 1 });
  });

  it("reports progress as units are confirmed", async () => {
    const seen: number[] = [];
    await translateUnits({
      units: [unit(1, "One"), unit(2, "Two")], store: new FakeStore(),
      backend: new FakeBackend([ok("[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue", 2)]),
      progress: { report: (p) => seen.push(p.done) },
      cacheKey: "k1", sourceLanguage: "en", targetLanguage: "it", concurrency: 1,
    });

    expect(seen.at(-1)).toBe(2);
  });

  it("adds up the tokens of the whole run", async () => {
    const backend = new FakeBackend((_call) => ({
      text: ok("[u:c1.xhtml#1]\nUno", 1), tokensIn: 7, tokensOut: 3, finishReason: "stop" as const,
    }));
    const summary = await run([unit(1, "One")], backend);

    expect(summary).toMatchObject({ tokensIn: 7, tokensOut: 3 });
  });
});
