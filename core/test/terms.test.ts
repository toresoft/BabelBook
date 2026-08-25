import { describe, expect, it } from "vitest";
import { measureAdherence, mergeTerms, termsForChunk, unitsAffectedByTerms } from "../translate/terms.ts";
import type { TermEntry } from "../glossary/index.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + source.length], source, raw: source, state: "translate",
});

const dnt = (source: string): TermEntry => ({ source, rule: "dnt", origin: "glossary" });
const must = (source: string, target: string, origin: TermEntry["origin"] = "glossary"): TermEntry =>
  ({ source, target, rule: "must", origin });
const prefer = (source: string, target: string): TermEntry =>
  ({ source, target, rule: "prefer", origin: "glossary" });

describe("mergeTerms", () => {
  it("lets a project term win over a glossary term for the same source", () => {
    expect(mergeTerms([must("dwarf", "nano")], [must("dwarf", "nanerottolo", "manual")]))
      .toEqual([must("dwarf", "nanerottolo", "manual")]);
  });

  it("keeps terms only one side has", () => {
    const merged = mergeTerms([dnt("Rivendell")], [must("dwarf", "nano", "extracted")]);
    expect(merged.map((t) => t.source).sort()).toEqual(["Rivendell", "dwarf"]);
  });
});

describe("termsForChunk", () => {
  it("sends only the terms the chunk actually contains", () => {
    expect(termsForChunk([dnt("Rivendell"), dnt("Mordor")], [unit(1, "The road to Rivendell")]))
      .toEqual([dnt("Rivendell")]);
  });

  it("sends nothing when the chunk contains nothing of the glossary", () => {
    expect(termsForChunk([dnt("Rivendell")], [unit(1, "A quiet evening")])).toEqual([]);
  });
});

describe("measureAdherence", () => {
  it("counts a dnt term left untouched as respected", () => {
    const measured = measureAdherence([dnt("Rivendell")], [
      { unit: unit(1, "To Rivendell"), text: "Verso Rivendell" },
    ]);
    expect(measured).toMatchObject({ checked: 1, respected: 1, violations: [] });
  });

  it("reports a dnt term that was translated anyway", () => {
    const measured = measureAdherence([dnt("Rivendell")], [
      { unit: unit(1, "To Rivendell"), text: "Verso Forravalle" },
    ]);
    expect(measured.violations).toEqual([
      { unitId: "c1.xhtml#1", term: "Rivendell", rule: "dnt" },
    ]);
  });

  it("reports a must term whose required rendering is missing", () => {
    const measured = measureAdherence([must("dwarf", "nano")], [
      { unit: unit(1, "the dwarf"), text: "il nanetto" },
    ]);
    expect(measured.violations[0]).toMatchObject({ term: "dwarf", rule: "must" });
  });

  it("counts a disregarded preference apart from a broken obligation", () => {
    const measured = measureAdherence([prefer("framework", "framework"), must("dwarf", "nano")], [
      { unit: unit(1, "the framework and the dwarf"), text: "l'impalcatura e il nano" },
    ]);

    expect(measured.byRule.prefer).toEqual({ checked: 1, respected: 0 });
    expect(measured.byRule.must).toEqual({ checked: 1, respected: 1 });
    expect(measured.violations.map((v) => v.rule)).toEqual(["prefer"]);
  });

  it("checks a term only in the units that contain it", () => {
    const measured = measureAdherence([dnt("Rivendell")], [
      { unit: unit(1, "To Rivendell"), text: "Verso Rivendell" },
      { unit: unit(2, "A quiet evening"), text: "Una sera tranquilla" },
    ]);
    expect(measured.checked).toBe(1);
  });

  it("says nothing was checked when no term appears anywhere", () => {
    const measured = measureAdherence([dnt("Mordor")], [
      { unit: unit(1, "A quiet evening"), text: "Una sera tranquilla" },
    ]);
    expect(measured).toMatchObject({ checked: 0, respected: 0, violations: [] });
  });
});

describe("unitsAffectedByTerms", () => {
  it("names only the units that contain a changed term", () => {
    expect(unitsAffectedByTerms([unit(1, "To Rivendell"), unit(2, "A quiet evening")], [dnt("Rivendell")]))
      .toEqual(["c1.xhtml#1"]);
  });

  it("names a unit once, however many changed terms it holds", () => {
    expect(unitsAffectedByTerms([unit(1, "The dwarf of Rivendell")], [dnt("Rivendell"), must("dwarf", "nano")]))
      .toEqual(["c1.xhtml#1"]);
  });

  it("names nothing when the changed term appears nowhere", () => {
    expect(unitsAffectedByTerms([unit(1, "A quiet evening")], [dnt("Rivendell")])).toEqual([]);
  });
});
