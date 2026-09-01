import { describe, expect, it } from "vitest";
import { translateChunk, translateUnits } from "../translate/engine.ts";
import { FakeBackend } from "./fake/backend.ts";
import { FakeStore, fakeStore } from "./fake/store.ts";
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
  /**
   * A provider that can impose the shape is not asked for it in words: the
   * schema travels with the call, and the instructions spend themselves on
   * the translation instead of on a header, a marker and a terminator.
   */
  it("asks a backend that can impose a shape for one, and asks the others in words", async () => {
    const withSchema = new FakeBackend(
      [JSON.stringify({ units: [{ id: "c1.xhtml#1", text: "Uno" }] })], true);
    const out = await translateChunk({
      chunk: chunk([unit(1, "One")]), terms: [], backend: withSchema,
    });

    expect(out.translated.get("c1.xhtml#1")).toBe("Uno");
    expect(withSchema.calls[0].schema).toBeDefined();
    expect(withSchema.calls[0].system).not.toContain("UNITS");
    expect(withSchema.prompts[0]).not.toContain("UNITS 1");

    const inWords = new FakeBackend([ok("[u:c1.xhtml#1]\nUno", 1)]);
    await translateChunk({ chunk: chunk([unit(1, "One")]), terms: [], backend: inWords });
    expect(inWords.calls[0].schema).toBeUndefined();
    expect(inWords.calls[0].system).toContain("UNITS");
  });

  /** The six levels hold whichever way the answer travelled. */
  it("holds a schema answer to the same levels", async () => {
    const backend = new FakeBackend(
      [JSON.stringify({ units: [{ id: "c1.xhtml#1", text: "步骤四：遵守法规与隐私" }] }),
       JSON.stringify({ units: [{ id: "c1.xhtml#1", text: "Passo quattro: le norme" }] })], true);

    const out = await translateChunk({
      chunk: chunk([unit(1, "Step four: complying with the regulations")]),
      terms: [], backend,
    });

    expect(out.attempts).toBe(2);
    expect(backend.prompts[1]).toContain("wrong-script");
    expect(out.translated.get("c1.xhtml#1")).toBe("Passo quattro: le norme");
  });


  it("accepts a good answer in one attempt", async () => {
    const out = await translateChunk({
      chunk: chunk([unit(1, "One"), unit(2, "Two")]), terms: [],
      backend: new FakeBackend([ok("[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue", 2)]),
    });

    expect(out.attempts).toBe(1);
    expect(out.translated.get("c1.xhtml#2")).toBe("Due");
    expect(out.fellBack).toEqual([]);
  });

  it("keeps what the last answer looked like, for the units that fell back", async () => {
    const thinking = new FakeBackend(() => ({
      text: "Let me work through the passage before I answer.",
      tokensIn: 900, tokensOut: 4096, reasoningTokens: 4096, finishReason: "length",
    }));

    const out = await translateChunk({ chunk: chunk([unit(1, "One")]), terms: [], backend: thinking });

    expect(out.fellBack).toEqual([{ unitId: "c1.xhtml#1", reason: "exhausted" }]);
    expect(out.lastAnswer).toEqual({
      finishReason: "length",
      reasoningTokens: 4096,
      excerpt: "Let me work through the passage before I answer.",
    });
  });

  it("keeps only the opening of a long answer, not the whole of it", async () => {
    const long = "x".repeat(500);
    const backend = new FakeBackend(() => ({
      text: long, tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop",
    }));

    const out = await translateChunk({ chunk: chunk([unit(1, "One")]), terms: [], backend });

    expect(out.lastAnswer?.excerpt).toBe("x".repeat(200));
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
        ? { text: "UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDu", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "length" as const }
        : { text: ok("[u:c1.xhtml#2]\nDue", 1), tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const });

    const out = await translateChunk({ chunk: chunk([unit(1, "One"), unit(2, "Two")]), terms: [], backend });
    expect(out.translated.size).toBe(2);
  });

  it("counts the tokens every attempt cost, not only the last", async () => {
    const backend = new FakeBackend((call) => ({
      text: call.prompt.includes("empty-text") ? ok("[u:c1.xhtml#1]\nUno", 1) : ok("[u:c1.xhtml#1]\n", 1),
      tokensIn: 10, tokensOut: 5, reasoningTokens: 0, finishReason: "stop" as const,
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

  it("asks again for a unit that fell back, instead of taking it for done", async () => {
    const units = [unit(1, "One")];
    const store = new FakeStore(units);
    await store.putTranslation({
      unitId: "c1.xhtml#1", text: "One", cacheKey: "k1", attempts: 3, outcome: "fell-back",
    });
    const backend = new FakeBackend([ok("[u:c1.xhtml#1]\nUno", 1)]);
    await run(units, backend, store);

    expect(backend.prompts).toHaveLength(1);
    expect((await store.translations("k1")).get("c1.xhtml#1")?.text).toBe("Uno");
  });

  it("does not count a fallback it is about to retry as work already done", async () => {
    const units = [unit(1, "One")];
    const store = new FakeStore(units);
    await store.putTranslation({
      unitId: "c1.xhtml#1", text: "One", cacheKey: "k1", attempts: 3, outcome: "fell-back",
    });
    const bad = ok("[u:c1.xhtml#1]\n", 1);
    const summary = await run(units, new FakeBackend([bad, bad, bad]), store);

    expect(summary.units.translated).toBe(0);
    expect(summary.units.fellBack).toBe(1);
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

  it("says in that event what the model answered, so exhausted is not the whole story", async () => {
    const store = new FakeStore();
    const thinking = new FakeBackend(() => ({
      text: "Thinking about it.",
      tokensIn: 900, tokensOut: 4096, reasoningTokens: 4096, finishReason: "length",
    }));
    await run([unit(1, "One")], thinking, store);

    const event = store.events.find((e) => e.code === "unit-fell-back");
    expect(event?.payload).toMatchObject({
      reason: "exhausted",
      finishReason: "length",
      reasoningTokens: 4096,
      excerpt: "Thinking about it.",
    });
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
      text: ok("[u:c1.xhtml#1]\nUno", 1), tokensIn: 7, tokensOut: 3, reasoningTokens: 0, finishReason: "stop" as const,
    }));
    const summary = await run([unit(1, "One")], backend);

    expect(summary).toMatchObject({ tokensIn: 7, tokensOut: 3 });
  });
});

describe("translateUnits and the model's window", () => {
  const answer = (ids: number[]) =>
    ok(ids.map((n) => `[u:c1.xhtml#${n}]\nT${n}`).join("\n"), ids.length);
  const base = (units: TranslationUnit[]) => ({
    units, store: new FakeStore(units), progress: { report() {} }, cacheKey: "k1",
    sourceLanguage: "en", targetLanguage: "it", concurrency: 1,
  });

  it("cuts smaller chunks for a model with a small window", async () => {
    // Four units of a thousand characters: the default budget would send them
    // together, a 2048-token window cannot hold them and their answer.
    const units = [1, 2, 3, 4].map((n) => unit(n, "x".repeat(1000)));
    const tight = new FakeBackend([answer([1, 2]), answer([3, 4])]);

    await translateUnits({ ...base(units), backend: tight, contextWindowTokens: 2048 });

    expect(tight.prompts).toHaveLength(2);
    expect(tight.prompts[0]).toContain("c1.xhtml#1");
    expect(tight.prompts[0]).not.toContain("c1.xhtml#3");
  });

  it("does not merge everything just because the window is huge", async () => {
    // Eight thousand characters would fit a million-token window in one go;
    // the ceiling is six thousand, so two chunks is the honest cut.
    const units = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => unit(n, "x".repeat(1000)));
    const wide = new FakeBackend([answer([1, 2, 3, 4, 5, 6]), answer([7, 8])]);

    await translateUnits({ ...base(units), backend: wide, contextWindowTokens: 1_000_000 });

    expect(wide.prompts).toHaveLength(2);
    expect(wide.prompts[0]).not.toContain("c1.xhtml#7");
  });

  it("plans exactly as before when the window is unknown", async () => {
    const units = [1, 2, 3, 4].map((n) => unit(n, "x".repeat(1000)));
    const unknowing = new FakeBackend([answer([1, 2, 3, 4])]);

    await translateUnits({ ...base(units), backend: unknowing });

    expect(unknowing.prompts).toHaveLength(1);
  });
});

/**
 * The failure that used to leave the run in a state nobody could describe.
 *
 * `Promise.all` rejects on the first throw, but the workers behind it keep
 * taking chunks off the queue. What they wrote landed after the run had been
 * declared failed: translations for a run that was over, tokens after the last
 * usage message, a `run_event` on a closed run. Whoever pressed resume then
 * started from a state that was still moving.
 */
describe("a run whose backend fails", () => {
  it("stops every worker, and writes nothing after the failure", async () => {
    // Long on purpose: the brief's short sentences all fit one chunk, and one
    // chunk means one worker — nothing left running for the defect to show.
    // At a thousand characters each, the planner cuts eight chunks of five,
    // and the workers that survive a failure have somewhere to be stopped.
    const units = Array.from({ length: 40 }, (_, at) => ({
      id: `u${at}`, kind: "block" as const, doc: "c1.xhtml", ordinal: at,
      range: [at, at] as [number, number], state: "translate" as const,
      source: `sentence number ${at} ${"x".repeat(1000)}`,
      raw: `<p>sentence number ${at}</p>`,
    }));

    let calls = 0;
    const backend = {
      call: async () => {
        calls++;
        if (calls === 2) throw new Error("the provider went away");
        await new Promise((resume) => setTimeout(resume, 5));
        return {
          text: "", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
        };
      },
    };

    const written: string[] = [];
    const store = fakeStore({ onPutTranslation: (unitId: string) => written.push(unitId) });

    await expect(translateUnits({
      units, store, backend, concurrency: 4,
      progress: { report: () => {} },
      cacheKey: "k", sourceLanguage: "en", targetLanguage: "it",
    })).rejects.toThrow("the provider went away");

    const afterTheThrow = written.length;
    await new Promise((resume) => setTimeout(resume, 60));
    expect(written.length).toBe(afterTheThrow);
  });
});
