import { describe, expect, it } from "vitest";
import { validate } from "../translate/validate.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + source.length], source, raw: source, state: "translate",
  ...(source.includes("<0>") || source.includes("<0/>")
    ? { placeholders: [{ index: 0, open: "<em>", close: "</em>", opaque: false }] }
    : {}),
});

const two = [unit(1, "One"), unit(2, "Two")];
const codes = (result: ReturnType<typeof validate>) => result.rejections.map((r) => r.code).sort();

describe("validate", () => {
  it("accepts a well formed answer", () => {
    const result = validate("UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue\nEND", two, "stop");

    expect(result.rejections).toEqual([]);
    expect(result.accepted.get("c1.xhtml#2")).toBe("Due");
  });

  it("level 1: rejects an answer with no structure at all", () => {
    const result = validate("Certo, ecco la traduzione: Uno e Due", two, "stop");

    expect(result.rejections[0].code).toBe("no-structure");
    expect(result.accepted.size).toBe(0);
  });

  it("level 2: rejects when the declared count does not match what arrived", () => {
    const result = validate("UNITS 2\n[u:c1.xhtml#1]\nUno\nEND", two, "stop");
    expect(codes(result)).toContain("count-mismatch");
  });

  it("level 3: rejects an empty translation and a marker left in the text", () => {
    const result = validate(
      "UNITS 2\n[u:c1.xhtml#1]\n\n[u:c1.xhtml#2]\nDue [u:c1.xhtml#3]\nEND", two, "stop");
    expect(codes(result)).toEqual(["empty-text", "marker-residue"]);
  });

  it("level 4: keeps the good units and rejects only the unknown id", () => {
    const result = validate(
      "UNITS 3\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue\n[u:c9.xhtml#9]\nNove\nEND", two, "stop");

    expect(result.accepted.size).toBe(2);
    expect(codes(result)).toContain("unknown-id");
  });

  it("level 4: reports a unit that never came back", () => {
    const result = validate("UNITS 1\n[u:c1.xhtml#1]\nUno\nEND", two, "stop");
    const missing = result.rejections.find((r) => r.code === "missing-id");

    expect(missing?.unitId).toBe("c1.xhtml#2");
    expect(result.accepted.get("c1.xhtml#1")).toBe("Uno");
  });

  it("level 4: rejects a unit answered twice, rather than picking one", () => {
    const result = validate(
      "UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#1]\nUno bis\nEND", [unit(1, "One")], "stop");

    expect(codes(result)).toContain("duplicate-id");
    expect(result.accepted.has("c1.xhtml#1")).toBe(false);
  });

  it("level 5: rejects a translation that dropped a placeholder", () => {
    const result = validate(
      "UNITS 1\n[u:c1.xhtml#1]\nUna affermazione audace\nEND",
      [unit(1, "A <0>bold</0> claim")], "stop");

    expect(result.rejections[0].code).toBe("placeholder-mismatch");
  });

  it("level 5: rejects a placeholder the source never had", () => {
    const result = validate(
      "UNITS 1\n[u:c1.xhtml#1]\nUna <0>audace</0> <1>affermazione</1>\nEND",
      [unit(1, "A <0>bold</0> claim")], "stop");
    expect(codes(result)).toContain("placeholder-mismatch");
  });

  it("level 5: rejects an unbalanced placeholder", () => {
    const result = validate(
      "UNITS 1\n[u:c1.xhtml#1]\nUna <0>audace claim\nEND",
      [unit(1, "A <0>bold</0> claim")], "stop");
    expect(codes(result)).toContain("placeholder-mismatch");
  });

  it("level 5: accepts a placeholder moved to where the target language wants it", () => {
    const result = validate(
      "UNITS 1\n[u:c1.xhtml#1]\nUn'affermazione <0>audace</0>\nEND",
      [unit(1, "A <0>bold</0> claim")], "stop");
    expect(result.rejections).toEqual([]);
  });

  it("marks truncation separately, because it is the only reason to split a chunk", () => {
    const result = validate("UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDu", two, "length");

    expect(result.truncated).toBe(true);
    expect(result.accepted.get("c1.xhtml#1")).toBe("Uno");
  });

  it("does not call an answer truncated when it finished and terminated", () => {
    const result = validate("UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue\nEND", two, "stop");
    expect(result.truncated).toBe(false);
  });

  it("every rejection names the unit it is about, when there is one", () => {
    const result = validate(
      "UNITS 2\n[u:c1.xhtml#1]\n\n[u:c1.xhtml#2]\nDue\nEND", two, "stop");
    expect(result.rejections.find((r) => r.code === "empty-text")?.unitId).toBe("c1.xhtml#1");
  });
});
