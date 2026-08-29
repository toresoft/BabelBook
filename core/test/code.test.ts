import { describe, expect, it } from "vitest";
import { indexCodeBlocks } from "../analyze/code.ts";
import { FakeBackend } from "./fake/backend.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (
  n: number | string, source: string, state: TranslationUnit["state"], reason?: string,
): TranslationUnit => {
  const ordinal = typeof n === "number" ? n : 0;
  return {
    id: typeof n === "number" ? `c1.xhtml#${n}` : n, kind: "block", doc: "c1.xhtml", ordinal,
    range: [ordinal, ordinal + source.length], source, raw: source, state,
    ...(reason === undefined ? {} : { reason }),
  };
};

const answer = (rows: string, batch = "1/1") =>
  `#CODEVERDICT v1 batch=${batch} count=${rows.trim().split("\n").length}\n${rows.trim()}\n@end`;

describe("indexCodeBlocks", () => {
  it("marks prose the deterministic rules missed as maybe-code", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "npm install --save-dev vitest", "translate")], sourceHash: "h1",
      backend: new FakeBackend([answer("[1] keep")]),
    });

    expect(index.marked).toEqual(["c1.xhtml#1"]);
    expect(index.freed).toEqual([]);
  });

  it("frees prose the stylesheet over-protected", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "The src/ directory holds the sources", "code", "css-code-surface")],
      sourceHash: "h1", backend: new FakeBackend([answer("[1] translate")]),
    });

    expect(index.freed).toEqual(["c1.xhtml#1"]);
    expect(index.marked).toEqual([]);
  });

  it("never frees a unit whose state came from the markup itself", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "ls -la", "code")], sourceHash: "h1",
      backend: new FakeBackend([answer("[1] translate")]),
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
      backend: new FakeBackend([answer("[1] translate")]),
    });
    expect(index).toMatchObject({ marked: [], freed: [] });
  });

  it("retries a malformed batch once before giving up on it", async () => {
    const backend = new FakeBackend(["not the format", answer("[1] keep")]);
    const index = await indexCodeBlocks({
      units: [unit(1, "npm install", "translate")], sourceHash: "h1", backend,
    });

    expect(backend.prompts).toHaveLength(2);
    expect(index).toMatchObject({ marked: ["c1.xhtml#1"], abstained: 0 });
  });

  it("turns a batch that stays malformed into an abstention, not a guess", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "Some text", "translate")], sourceHash: "h1",
      backend: new FakeBackend(["I think unit one is code", "still not the format", "again, not the format"]),
    });

    expect(index).toMatchObject({ marked: [], freed: [], abstained: 1 });
  });

  it("rejects a verdict about an ordinal it did not ask about", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "Some text", "translate")], sourceHash: "h1",
      backend: new FakeBackend([answer("[2] keep"), answer("[2] keep"), answer("[2] keep")]),
    });
    expect(index).toMatchObject({ marked: [], abstained: 1 });
  });

  it("asks in batches, so one bad answer does not cost the whole book", async () => {
    const units = Array.from({ length: 5 }, (_, i) => unit(i + 1, `Line ${i + 1}`, "translate"));
    const backend = new FakeBackend((call) => {
      const header = /^#CODEINDEX v1 batch=(\d+\/\d+) count=(\d+)$/m.exec(call.prompt)!;
      const count = Number(header[2]);
      return {
        text: answer(Array.from({ length: count }, (_, at) => `[${at + 1}] translate`).join("\n"), header[1]),
        tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
      };
    });

    await indexCodeBlocks({ units, sourceHash: "h1", backend, batchSize: 2 });
    expect(backend.prompts).toHaveLength(3);
  });

  it("carries the hash of the source it was built from", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "Text", "translate")], sourceHash: "abc123",
      backend: new FakeBackend([answer("[1] translate")]),
    });
    expect(index.sourceHash).toBe("abc123");
  });

  it("stops on an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(indexCodeBlocks({
      units: [unit(1, "Text", "translate")], sourceHash: "h1",
      backend: new FakeBackend([answer("[1] translate")]), signal: controller.signal,
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

  /**
   * Sequential, this pass is the longest thing in a run and the reason the bar
   * looked hung. The batches are independent — none reads what another decided —
   * so they go out as wide as the run allows.
   */
  it("judges the batches in parallel", async () => {
    let running = 0;
    let highest = 0;
    const units = Array.from({ length: 6 }, (_, at) => unit(`c1.xhtml#${at}`, "translate", "translate"));

    await indexCodeBlocks({
      units,
      backend: {
        call: async () => {
          running++;
          highest = Math.max(highest, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running--;
          return {
            text: "#CODEVERDICT v1 batch=1/3 count=2\n[1] translate\n[2] translate\n@end",
            tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
          };
        },
      },
      sourceHash: "h",
      batchSize: 2,
      concurrency: 3,
    });

    expect(highest).toBeGreaterThan(1);
  });

  /**
   * An abstention never changes a deterministic state, and it is still counted.
   * That rule is babelBook's and it does not change here.
   */
  it("abstains without moving anything when the format never comes back", async () => {
    const units = [unit("c1.xhtml#1", "translate", "translate")];
    const index = await indexCodeBlocks({
      units,
      backend: { call: async () => ({
        text: "sorry", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
      }) },
      sourceHash: "h",
    });

    expect(index).toMatchObject({ marked: [], freed: [], abstained: 1 });
  });
});
