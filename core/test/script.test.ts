import { describe, expect, it } from "vitest";
import { scriptsOf, scriptsWritingIn, foreignScript } from "../translate/script.ts";

describe("scriptsOf", () => {
  it("counts letters by script and ignores everything that is not one", () => {
    expect(scriptsOf("Ciao, mondo! 42 —")).toEqual(new Map([["Latin", 9]]));
    expect(scriptsOf("步骤4：遵守AI与数据隐私法规").get("Han")).toBe(11);
    expect(scriptsOf("步骤4：遵守AI与数据隐私法规").get("Latin")).toBe(2);
  });

  it("reads Japanese as the three scripts it is written in", () => {
    const found = scriptsOf("これは日本語のテキストです");
    expect([...found.keys()].sort()).toEqual(["Han", "Hiragana", "Katakana"]);
  });

  it("has nothing to say about a text with no letters", () => {
    expect(scriptsOf("42 — <0/> 3.14 …")).toEqual(new Map());
  });
});

describe("scriptsWritingIn", () => {
  it("knows the script a language is written in", () => {
    expect(scriptsWritingIn("it")).toEqual(new Set(["Latin"]));
    expect(scriptsWritingIn("ru")).toEqual(new Set(["Cyrillic"]));
    expect(scriptsWritingIn("ja")).toEqual(new Set(["Han", "Hiragana", "Katakana"]));
    expect(scriptsWritingIn("pt-BR")).toEqual(new Set(["Latin"]));
  });

  /** An unknown tag is not an excuse to guess: the check stands down. */
  it("answers nothing for a language it does not know", () => {
    expect(scriptsWritingIn("xx")).toBeNull();
  });
});

/**
 * Production break: `deepseek-v4-flash` with thinking disabled answered 645 of
 * 1686 units in Chinese. Every one of them kept the markers, the count, the
 * terminator and the placeholders, so all five levels passed them, and the
 * book was composed, declared complete and exported one third in Chinese.
 */
describe("foreignScript", () => {
  it("names the script of an answer written in the wrong language", () => {
    expect(foreignScript(
      "Step 4: Complying with AI & Data Privacy Regulations",
      "步骤4：遵守AI与数据隐私法规", "it",
    )).toBe("Han");
  });

  it("says nothing about an answer in the target's own script", () => {
    expect(foreignScript(
      "Step 4: Complying with Data Privacy",
      "Passo 4: conformarsi alle norme sulla riservatezza", "it",
    )).toBeNull();
  });

  /** A quotation the author wrote in another script is the source's, not ours. */
  it("allows a script the source itself is written in", () => {
    expect(foreignScript(
      "The sign read 这是出口 and nothing else",
      "Il cartello diceva 这是出口 e nient'altro", "it",
    )).toBeNull();
  });

  /** Italian with a Chinese clause inside it is not an Italian translation. */
  it("catches an answer contaminated well below half", () => {
    expect(foreignScript(
      "Open the editor and add a node to the canvas",
      "Apri l'editor e aggiungi un nodo 到画布上以便继续操作", "it",
    )).toBe("Han");
  });

  it("judges nothing when there are too few letters to judge", () => {
    expect(foreignScript("n8n", "n8n", "it")).toBeNull();
    expect(foreignScript("42", "42", "it")).toBeNull();
  });

  it("stands down for a target language it does not know the script of", () => {
    expect(foreignScript("Hello", "你好世界你好世界", "xx")).toBeNull();
  });

  it("accepts Chinese when Chinese is what was asked for", () => {
    expect(foreignScript(
      "Step 4: Complying with AI & Data Privacy Regulations",
      "步骤4：遵守AI与数据隐私法规", "zh",
    )).toBeNull();
  });
});
