import { describe, expect, it } from "vitest";
import { sampleBlocks } from "../analyze/sample.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, state: TranslationUnit["state"] = "translate", text = `Sentence number ${n}`): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n * 10, n * 10 + text.length], source: text, raw: text, state,
});

describe("sampleBlocks", () => {
  it("returns three samples taken from distant parts of the book", () => {
    const units = Array.from({ length: 300 }, (_, i) => unit(i + 1));
    const samples = sampleBlocks(units);

    expect(samples).toHaveLength(3);
    expect(samples[0][0]).not.toBe(samples[2][0]);
  });

  it("takes each sample from its own third, so the vote is not an echo", () => {
    const units = Array.from({ length: 300 }, (_, i) => unit(i + 1));
    const ordinalOf = (text: string) => Number(/\d+/.exec(text)![0]);
    const [first, second, third] = sampleBlocks(units).map((s) => ordinalOf(s[0]));

    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    expect(third - first).toBeGreaterThan(100);
  });

  it("never samples a unit that is not work", () => {
    const units = [unit(1, "code"), unit(2, "translate-no"), unit(3)];
    expect(sampleBlocks(units).flat()).toEqual(["Sentence number 3"]);
  });

  it("samples a suspected code unit, which is still work", () => {
    expect(sampleBlocks([unit(1, "maybe-code")]).flat()).toEqual(["Sentence number 1"]);
  });

  it("returns fewer samples than asked rather than repeating itself", () => {
    expect(sampleBlocks([unit(1)], 3)).toHaveLength(1);
    expect(sampleBlocks([], 3)).toEqual([]);
  });

  it("keeps a sample within its character budget", () => {
    const units = Array.from({ length: 60 }, (_, i) => unit(i + 1, "translate", "x".repeat(500)));
    for (const sample of sampleBlocks(units)) {
      expect(sample.join("").length).toBeLessThanOrEqual(2000);
      expect(sample.length).toBeGreaterThan(0);
    }
  });

  it("keeps the units of a sample contiguous, so it reads as prose", () => {
    const units = Array.from({ length: 90 }, (_, i) => unit(i + 1));
    for (const sample of sampleBlocks(units)) {
      const ordinals = sample.map((text) => Number(/\d+/.exec(text)![0]));
      expect(ordinals).toEqual(ordinals.map((_, i) => ordinals[0] + i));
    }
  });
});
