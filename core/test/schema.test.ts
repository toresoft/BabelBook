import { describe, expect, it } from "vitest";
import { buildSchemaPayload, parseSchemaResponse, TRANSLATION_SCHEMA } from "../translate/schema.ts";
import { buildSchemaSystem } from "../translate/instructions.ts";
import type { ChunkContext } from "../translate/types.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + source.length], source, raw: source, state: "translate",
});

const context: ChunkContext = {
  chapter: { doc: "c1.xhtml", position: 1, total: 3 }, sourceLanguage: "en", targetLanguage: "it",
  before: [], after: [], interleaved: [],
};

describe("the schema contract", () => {
  /**
   * The whole point: the shape is imposed by the provider, so the words do not
   * have to carry it. What is left is the work.
   */
  it("says almost nothing about the format, because it does not have to", () => {
    const system = buildSchemaSystem({ units: [unit(1, "One")], context, terms: [] });

    expect(system.length).toBeLessThan(700);
    expect(system).not.toContain("UNITS");
    expect(system).not.toContain("END");
    expect(system.split("\n")[0]).toContain("Italian");
    expect(system.split("\n").filter((l) => l !== "").at(-1)).toContain("Italian");
  });

  /** The rules that are about translating are the same under both contracts. */
  it("keeps the rules that have nothing to do with the format", () => {
    const system = buildSchemaSystem({ units: [unit(1, "One")], context, terms: [] });

    expect(system.toLowerCase()).toContain("placeholder");
    expect(system.toLowerCase()).toMatch(/command|code|console/);
    expect(system.toLowerCase()).toContain("register");
  });

  it("sends the units with their ids, and the terminology, like the other contract", () => {
    const payload = buildSchemaPayload({
      units: [unit(1, "One"), unit(2, "Two")], context,
      terms: [{ source: "n8n", rule: "dnt", origin: "extracted" }],
    });

    expect(payload).toContain("[u:c1.xhtml#1]");
    expect(payload).toContain("[u:c1.xhtml#2]");
    expect(payload).toContain("n8n");
    expect(payload).toContain("Italian");
    expect(payload).not.toContain("UNITS 2");
    expect(payload.trimEnd().endsWith("END")).toBe(false);
  });

  it("declares a shape that names an id and a text per unit", () => {
    const units = (TRANSLATION_SCHEMA as Record<string, any>).properties.units;
    expect(units.type).toBe("array");
    expect(Object.keys(units.items.properties).sort()).toEqual(["id", "text"]);
    expect(units.items.required.sort()).toEqual(["id", "text"]);
  });
});

describe("parseSchemaResponse", () => {
  it("reads the answer into the same shape the text parser produces", () => {
    const parsed = parseSchemaResponse(JSON.stringify({
      units: [{ id: "c1.xhtml#1", text: "Uno" }, { id: "c1.xhtml#2", text: "Due" }],
    }));

    expect(parsed).toEqual({
      declared: 2,
      lines: [{ unitId: "c1.xhtml#1", text: "Uno" }, { unitId: "c1.xhtml#2", text: "Due" }],
      terminated: true,
    });
  });

  /** Level 1 catches it, exactly as it catches prose where a block was asked for. */
  it("answers with no structure when the JSON is broken or the wrong shape", () => {
    const none = { declared: null, lines: [], terminated: false };
    expect(parseSchemaResponse("{ not json")).toEqual(none);
    expect(parseSchemaResponse(JSON.stringify({ translations: [] }))).toEqual(none);
    expect(parseSchemaResponse(JSON.stringify({ units: "no" }))).toEqual(none);
  });

  /** An entry that is not a pair of strings is dropped, and level 4 will say so. */
  it("drops an entry that is not an id and a text", () => {
    const parsed = parseSchemaResponse(JSON.stringify({
      units: [{ id: "c1.xhtml#1", text: "Uno" }, { id: 7, text: "Due" }, { id: "c1.xhtml#3" }],
    }));

    expect(parsed.lines).toEqual([{ unitId: "c1.xhtml#1", text: "Uno" }]);
    expect(parsed.declared).toBe(1);
  });
});
