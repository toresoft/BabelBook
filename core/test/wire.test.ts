import { describe, expect, it } from "vitest";
import { buildPayload, buildSystem, parseResponse } from "../translate/wire.ts";
import type { ChunkContext } from "../translate/types.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string, state: TranslationUnit["state"] = "translate"): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + source.length], source, raw: source, state,
});

const context: ChunkContext = {
  sourceLanguage: "en", targetLanguage: "it", before: [], after: [], interleaved: [],
  chapter: { doc: "c1.xhtml", position: 1, total: 1 },
};

describe("buildPayload", () => {
  it("declares how many units it sends and marks each one", () => {
    const payload = buildPayload({ units: [unit(1, "One"), unit(2, "Two")], context, terms: [] });

    expect(payload).toContain("UNITS 2");
    expect(payload).toContain("[u:c1.xhtml#1]");
    expect(payload).toContain("[u:c1.xhtml#2]");
    expect(payload.trimEnd().endsWith("END")).toBe(true);
  });

  /**
   * Production break: the last instruction before the units was about the
   * format, and the only line naming the language sat 1600 characters above
   * it. A model that had spent all its attention on the protocol translated
   * one book in three into Chinese.
   */
  it("names the target language where the work is actually asked for", () => {
    const payload = buildPayload({ units: [unit(1, "One"), unit(2, "Two")], context, terms: [] });
    const asked = payload.split("\n").find((line) => line.startsWith("Translate the"))!;

    expect(asked).toContain("Italian");
  });

  it("refuses a unit that is not work", () => {
    expect(() => buildPayload({ units: [unit(1, "x = 1", "code")], context, terms: [] }))
      .toThrow(/c1\.xhtml#1/);
  });

  it("refuses to send nothing at all", () => {
    expect(() => buildPayload({ units: [], context, terms: [] })).toThrow();
  });

  it("puts the active terms in the payload with their rule", () => {
    const payload = buildPayload({
      units: [unit(1, "Rivendell is far")], context,
      terms: [
        { source: "Rivendell", rule: "dnt", origin: "glossary" },
        { source: "dwarf", target: "nano", rule: "must", origin: "glossary" },
      ],
    });

    expect(payload).toContain("Rivendell");
    expect(payload).toContain("dnt");
    expect(payload).toContain("nano");
  });

  it("carries the surrounding text as context, marked as not to be translated", () => {
    const payload = buildPayload({
      units: [unit(2, "The middle")],
      context: { ...context, before: ["What came before"], after: ["What comes after"] },
      terms: [],
    });

    expect(payload).toContain("What came before");
    expect(payload).toContain("What comes after");
    expect(payload.indexOf("What came before")).toBeLessThan(payload.indexOf("UNITS 1"));
  });

  it("keeps a unit's text intact, marker and all, so nothing is re-encoded", () => {
    const payload = buildPayload({
      units: [unit(1, "A <0>bold</0> claim")], context, terms: [],
    });
    expect(payload).toContain("A <0>bold</0> claim");
  });
});

/**
 * Production break: the instructions stopped naming the `UNITS` header and a
 * model stopped writing it — while copying every marker, closing with END and
 * translating correctly. The parser demanded the header, discarded the whole
 * answer at level 1, and 180 units of a book fell back to English after three
 * paid attempts each.
 */
describe("an answer without the header", () => {
  it("is read from its first marker, because the marker is anchor enough", () => {
    const parsed = parseResponse("[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue\nEND");

    expect(parsed.lines).toEqual([
      { unitId: "c1.xhtml#1", text: "Uno" }, { unitId: "c1.xhtml#2", text: "Due" },
    ]);
    // Nothing was declared, so there is no declaration to disagree with: what
    // is missing is level 4's to report, unit by unit.
    expect(parsed.declared).toBe(2);
  });

  it("still skips whatever a model said before the block", () => {
    const parsed = parseResponse("Certo, ecco la traduzione:\n\n[u:c1.xhtml#1]\nUno\nEND");

    expect(parsed.lines).toEqual([{ unitId: "c1.xhtml#1", text: "Uno" }]);
  });

  /** Neither a header nor a marker is an answer nothing can be read out of. */
  it("is no structure at all when there is no marker either", () => {
    expect(parseResponse("Uno e Due, ecco.")).toEqual({
      declared: null, lines: [], terminated: false,
    });
  });

  /** With a header, its count is still the model's own declaration. */
  it("keeps the declared count when the header is there", () => {
    expect(parseResponse("UNITS 5\n[u:c1.xhtml#1]\nUno\nEND").declared).toBe(5);
  });
});

describe("buildSystem", () => {
  it("names the languages and the rules that carry weight", () => {
    const system = buildSystem({ units: [unit(1, "One")], context, terms: [] });

    expect(system).toContain("English");
    expect(system).toContain("Italian");
    expect(system.toLowerCase()).toContain("placeholder");
  });

  it("tells the model to reproduce unmarked code unchanged", () => {
    const system = buildSystem({ units: [unit(1, "One")], context, terms: [] });
    expect(system.toLowerCase()).toMatch(/command|code|console/);
  });

  it("names the three tokens the answer is read by, rather than calling it the format", () => {
    const system = buildSystem({ units: [unit(1, "One")], context, terms: [] });

    expect(system).toMatch(/UNITS <n>|UNITS \d/);
    expect(system).toContain("[u:");
    expect(system).toContain("END");
  });

  /**
   * The instructions were 1631 characters, 78% of them about the format and
   * 47 about the work. What a model gives its attention to is what it is
   * mostly told, and it showed: the protocol was obeyed to the letter and the
   * language was forgotten.
   */
  it("spends itself on the work, not on the protocol", () => {
    const system = buildSystem({ units: [unit(1, "One")], context, terms: [] });
    const lines = system.split("\n");

    expect(system.length).toBeLessThan(1100);
    // Said first and said last: the two positions a model reads hardest.
    expect(lines[0]).toContain("Italian");
    expect(lines.filter((line) => line !== "").at(-1)).toContain("Italian");
  });

  it("shows a whole answer, and our own reader accepts it", () => {
    const system = buildSystem({ units: [unit(1, "One")], context, terms: [] });

    // The worked example is the contract's only unambiguous half: a model that
    // copies its shape answers correctly. Reading it back with the parser the
    // engine actually uses is what stops the example from drifting away from it.
    const example = /^UNITS \d+$[\s\S]*?^END$/m.exec(system);
    expect(example).not.toBeNull();

    const parsed = parseResponse(example![0]);
    expect(parsed.terminated).toBe(true);
    expect(parsed.lines).toHaveLength(parsed.declared!);
    expect(parsed.lines.every((line) => line.text !== "")).toBe(true);
  });
});

describe("parseResponse", () => {
  it("reads a well formed answer", () => {
    expect(parseResponse("UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue\nEND")).toEqual({
      declared: 2,
      terminated: true,
      lines: [{ unitId: "c1.xhtml#1", text: "Uno" }, { unitId: "c1.xhtml#2", text: "Due" }],
    });
  });

  it("keeps a multi-line translation whole", () => {
    const parsed = parseResponse("UNITS 1\n[u:c1.xhtml#1]\nPrima riga\nSeconda riga\nEND");
    expect(parsed.lines[0].text).toBe("Prima riga\nSeconda riga");
  });

  it("reports the missing terminator instead of trusting a truncated answer", () => {
    expect(parseResponse("UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDu").terminated).toBe(false);
  });

  it("ignores chatter around the block", () => {
    const parsed = parseResponse("Sure, here you go:\nUNITS 1\n[u:c1.xhtml#1]\nUno\nEND\nHope this helps!");
    expect(parsed.lines).toEqual([{ unitId: "c1.xhtml#1", text: "Uno" }]);
  });

  it("says nothing was declared when there is no header", () => {
    expect(parseResponse("Uno e Due")).toEqual({ declared: null, lines: [], terminated: false });
  });

  it("keeps an empty translation as empty rather than dropping the unit", () => {
    const parsed = parseResponse("UNITS 2\n[u:c1.xhtml#1]\n\n[u:c1.xhtml#2]\nDue\nEND");
    expect(parsed.lines).toEqual([
      { unitId: "c1.xhtml#1", text: "" }, { unitId: "c1.xhtml#2", text: "Due" },
    ]);
  });
});
