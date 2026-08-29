import { describe, expect, it } from "vitest";
import { indexCodeBlocks } from "../analyze/code.ts";
import { FakeBackend } from "./fake/backend.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (
  n: number, source: string, state: TranslationUnit["state"], reason?: string,
): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + source.length], source, raw: source, state,
  ...(reason === undefined ? {} : { reason }),
});

const answer = (rows: string) =>
  `VERDICTS ${rows.trim().split("\n").length}\n${rows.trim()}\nEND`;

describe("indexCodeBlocks", () => {
  it("marks prose the deterministic rules missed as maybe-code", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "npm install --save-dev vitest", "translate")], sourceHash: "h1",
      backend: new FakeBackend([answer("[v:c1.xhtml#1] code")]),
    });

    expect(index.marked).toEqual(["c1.xhtml#1"]);
    expect(index.freed).toEqual([]);
  });

  it("frees prose the stylesheet over-protected", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "The src/ directory holds the sources", "code", "css-code-surface")],
      sourceHash: "h1", backend: new FakeBackend([answer("[v:c1.xhtml#1] prose")]),
    });

    expect(index.freed).toEqual(["c1.xhtml#1"]);
    expect(index.marked).toEqual([]);
  });

  it("never frees a unit whose state came from the markup itself", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "ls -la", "code")], sourceHash: "h1",
      backend: new FakeBackend([answer("[v:c1.xhtml#1] prose")]),
    });
    expect(index.freed).toEqual([]);
  });

  it("does not ask about units nobody would translate anyway", async () => {
    const backend = new FakeBackend([]);
    const index = await indexCodeBlocks({
      units: [unit(1, "var a = 1", "never-translated"), unit(2, "Brand", "translate-no")],
      sourceHash: "h1", backend,
    });

    expect(backend.prompts).toEqual([]);
    expect(index).toMatchObject({ marked: [], freed: [], abstained: 0 });
  });

  it("leaves a unit alone when the model agrees with what we deduced", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "A quiet evening", "translate")], sourceHash: "h1",
      backend: new FakeBackend([answer("[v:c1.xhtml#1] prose")]),
    });
    expect(index).toMatchObject({ marked: [], freed: [] });
  });

  it("retries a malformed batch once before giving up on it", async () => {
    const backend = new FakeBackend(["not the format", answer("[v:c1.xhtml#1] code")]);
    const index = await indexCodeBlocks({
      units: [unit(1, "npm install", "translate")], sourceHash: "h1", backend,
    });

    expect(backend.prompts).toHaveLength(2);
    expect(index).toMatchObject({ marked: ["c1.xhtml#1"], abstained: 0 });
  });

  it("turns a batch that stays malformed into an abstention, not a guess", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "Some text", "translate")], sourceHash: "h1",
      backend: new FakeBackend(["I think unit one is code", "still not the format"]),
    });

    expect(index).toMatchObject({ marked: [], freed: [], abstained: 1 });
  });

  it("ignores a verdict about a unit it did not ask about", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "Some text", "translate")], sourceHash: "h1",
      backend: new FakeBackend([answer("[v:c9.xhtml#9] code"), answer("[v:c9.xhtml#9] code")]),
    });
    expect(index).toMatchObject({ marked: [], abstained: 1 });
  });

  it("asks in batches, so one bad answer does not cost the whole book", async () => {
    const units = Array.from({ length: 5 }, (_, i) => unit(i + 1, `Line ${i + 1}`, "translate"));
    const backend = new FakeBackend((call) => {
      const asked = [...new Set([...call.prompt.matchAll(/\[v:([^\]<]+)\]/g)].map((m) => m[1]))];
      return {
        text: answer(asked.map((id) => `[v:${id}] prose`).join("\n")),
        tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
      };
    });

    await indexCodeBlocks({ units, sourceHash: "h1", backend, batchSize: 2 });
    expect(backend.prompts).toHaveLength(3);
  });

  it("carries the hash of the source it was built from", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "Text", "translate")], sourceHash: "abc123",
      backend: new FakeBackend([answer("[v:c1.xhtml#1] prose")]),
    });
    expect(index.sourceHash).toBe("abc123");
  });

  it("stops on an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(indexCodeBlocks({
      units: [unit(1, "Text", "translate")], sourceHash: "h1",
      backend: new FakeBackend([answer("[v:c1.xhtml#1] prose")]), signal: controller.signal,
    })).rejects.toThrow();
  });

  /**
   * The bar is the only thing that separates a long phase from a hung one. This
   * phase is the longest in a run — one call per twenty blocks, on a real book
   * hundreds of them — and until now it reported nothing at all.
   */
  it("reports one step per batch, against the number of batches", async () => {
    const units = Array.from({ length: 5 }, (_, at) => unit(at + 1, "text", "translate"));
    const seen: Array<{ phase: string; done: number; total: number }> = [];

    await indexCodeBlocks({
      units,
      // The reply form, not the scripted array: an array that runs out THROWS,
      // by design, and this test makes more calls than it cares to script.
      backend: new FakeBackend(() => ({
        text: "nothing in the format", tokensIn: 0, tokensOut: 0,
        reasoningTokens: 0, finishReason: "stop",
      })),
      sourceHash: "h",
      batchSize: 2,
      progress: { report: (p) => seen.push({ phase: p.phase, done: p.done, total: p.total }) },
    });

    // Three batches out of five units, and a step after each. The order is not
    // asserted: Task 8 sends the batches out in parallel, and a test that fixed
    // the order here would have to be rewritten there for no gain.
    expect(seen).toHaveLength(3);
    expect(seen.every((step) => step.phase === "code-index" && step.total === 3)).toBe(true);
    expect(new Set(seen.map((step) => step.done))).toEqual(new Set([1, 2, 3]));
  });
});
