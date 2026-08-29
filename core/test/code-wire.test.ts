import { describe, expect, it } from "vitest";
import { batchUnits, buildCodePrompt, parseCodeVerdict } from "../analyze/code-wire.ts";
import type { TranslationUnit } from "../epub/index.ts";

function unit(id: string, source: string, element = "p", className?: string): TranslationUnit {
  return {
    id, kind: "block", doc: "c1.xhtml", ordinal: 1, range: [0, 1],
    source, raw: source, state: "translate", element,
    ...(className === undefined ? {} : { className }),
  };
}

describe("the code-index wire", () => {
  /**
   * The whole block on one line. A listing carries its own newlines, and a
   * format that puts one block per line cannot survive them: the answer comes
   * back misaligned and the batch abstains in silence.
   */
  it("flattens a multi-line listing onto a single line", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "const a = 1;\nconst b = 2;", "pre")])[0]!;
    const body = buildCodePrompt(batch).split("\n").filter((line) => line.startsWith("[1]"));

    expect(body).toHaveLength(1);
    expect(body[0]).toContain("const a = 1; const b = 2;");
  });

  it("shows the element and its class beside the text", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "A sentence.", "p", "TX")])[0]!;
    expect(buildCodePrompt(batch)).toContain("p.TX");
  });

  /**
   * Compact ordinals, not unit ids. An id is `c1.xhtml#1247`; asking a model
   * to echo twelve hundred of them exactly is paying for tokens to buy a
   * transcription error.
   */
  it("asks for ordinals and maps them back to the ids", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "one"), unit("c1.xhtml#2", "two")])[0]!;
    const verdict = parseCodeVerdict(
      "#CODEVERDICT v1 batch=1/1 count=2\n[1] keep\n[2] translate\n@end",
      batch,
    );

    expect(verdict).toEqual({ ok: true, code: new Set(["c1.xhtml#1"]), prose: new Set(["c1.xhtml#2"]) });
  });

  /**
   * A block that contains the word the old format terminated on used to end
   * the parsing early, and the rest of the batch vanished.
   */
  it("is not terminated by a block that contains the terminator", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "END", "pre"), unit("c1.xhtml#2", "two")])[0]!;
    const verdict = parseCodeVerdict(
      "#CODEVERDICT v1 batch=1/1 count=2\n[1] keep\n[2] translate\n@end",
      batch,
    );

    expect(verdict.ok).toBe(true);
  });

  it("refuses a count that does not match what was asked", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "one"), unit("c1.xhtml#2", "two")])[0]!;
    const verdict = parseCodeVerdict("#CODEVERDICT v1 batch=1/1 count=1\n[1] keep\n@end", batch);
    expect(verdict).toEqual({ ok: false, reason: "expected count 2, found 1" });
  });

  /** The older vocabulary is out of date, not wrong. */
  it("still reads code and prose", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "one")])[0]!;
    const verdict = parseCodeVerdict("#CODEVERDICT v1 batch=1/1 count=1\n[1] code\n@end", batch);
    expect(verdict).toEqual({ ok: true, code: new Set(["c1.xhtml#1"]), prose: new Set() });
  });
});

/**
 * The question this pass asks is the translator's, not a classifier's. Asked
 * "is this code?", a model calls a sentence about `AuthModule` code; asked
 * "would you translate it?", it does not. The prompt is a contract, so the
 * words that carry the change are asserted rather than left to a reading.
 */
describe("the question", () => {
  it("asks what a translator would do, and about the whole line", () => {
    const prompt = buildCodePrompt(batchUnits([unit("c1.xhtml#1", "one")])[0]!);
    expect(prompt).toContain("TRANSLATE it, or KEEP it exactly as it is");
    expect(prompt).toContain("Judge the whole line, never the parts inside it");
  });

  it("carries the reason the previous attempt was refused", () => {
    const prompt = buildCodePrompt(batchUnits([unit("c1.xhtml#1", "one")])[0]!, "terminator @end not found");
    expect(prompt).toContain("terminator @end not found");
  });
});
