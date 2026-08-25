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
