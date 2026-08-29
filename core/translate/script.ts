/**
 * Which writing system a text is in, and which one it was supposed to be in.
 *
 * Not which *language*: no counting of characters distinguishes Italian from
 * Spanish, and pretending otherwise would put a confident sentence on a guess.
 * A script is a different matter — it is a property of the characters
 * themselves, and answering in Han where Latin was asked for is a failure that
 * needs no judgement to see.
 *
 * This exists because a model can obey every rule of the protocol and still
 * translate into the wrong language. Measured on a real book: 645 units of
 * 1686 came back in Chinese with the markers, the count, the terminator and
 * the placeholders all intact, so the five levels of `validate` passed every
 * one of them and the book was declared complete.
 */

/** The scripts worth telling apart, each as the letters that belong to it. */
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Latin", /\p{Script=Latin}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Han", /\p{Script=Han}/u],
  ["Hiragana", /\p{Script=Hiragana}/u],
  ["Katakana", /\p{Script=Katakana}/u],
  ["Hangul", /\p{Script=Hangul}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
  ["Thai", /\p{Script=Thai}/u],
];

const LETTER = /\p{L}/u;

/**
 * The script each language is written in.
 *
 * Keyed by the primary subtag, so `pt-BR` and `pt` answer the same. A language
 * this table does not know returns null, and null stands the check down: an
 * invented expectation would reject correct translations into every language
 * nobody thought to list.
 */
const WRITTEN_IN: Record<string, readonly string[]> = {
  en: ["Latin"], it: ["Latin"], fr: ["Latin"], de: ["Latin"], es: ["Latin"],
  pt: ["Latin"], nl: ["Latin"], sv: ["Latin"], da: ["Latin"], no: ["Latin"],
  fi: ["Latin"], pl: ["Latin"], cs: ["Latin"], sk: ["Latin"], hu: ["Latin"],
  ro: ["Latin"], hr: ["Latin"], sl: ["Latin"], lt: ["Latin"], lv: ["Latin"],
  et: ["Latin"], tr: ["Latin"], id: ["Latin"], ms: ["Latin"], vi: ["Latin"],
  ca: ["Latin"], gl: ["Latin"], eu: ["Latin"],
  ru: ["Cyrillic"], uk: ["Cyrillic"], bg: ["Cyrillic"], sr: ["Cyrillic"],
  be: ["Cyrillic"], mk: ["Cyrillic"],
  el: ["Greek"],
  zh: ["Han"],
  ja: ["Han", "Hiragana", "Katakana"],
  ko: ["Hangul"],
  ar: ["Arabic"], fa: ["Arabic"], ur: ["Arabic"],
  he: ["Hebrew"],
  hi: ["Devanagari"], mr: ["Devanagari"], ne: ["Devanagari"],
  th: ["Thai"],
};

/**
 * Below this there is nothing to judge.
 *
 * A unit that is a product name, a number or an abbreviation carries no
 * evidence of any language, and rejecting one for the script of its four
 * letters would send a chunk back for a unit that was never wrong.
 */
const MIN_LETTERS = 8;

/**
 * A script has to be more than a tenth of the letters to be an answer's doing
 * rather than a word it borrowed.
 */
const SHARE = 0.1;

/** How many letters of each script a text carries. Letters only: nothing else votes. */
export function scriptsOf(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const character of text) {
    if (!LETTER.test(character)) continue;
    for (const [name, pattern] of SCRIPTS) {
      if (pattern.test(character)) {
        found.set(name, (found.get(name) ?? 0) + 1);
        break;
      }
    }
  }
  return found;
}

/** The scripts a language is written in, or null when we do not know it. */
export function scriptsWritingIn(language: string): Set<string> | null {
  const primary = language.split("-")[0]!.toLowerCase();
  const scripts = WRITTEN_IN[primary];
  return scripts === undefined ? null : new Set(scripts);
}

/**
 * The script an answer is written in that has no business being there, if any.
 *
 * A script earns its place two ways: the target language is written in it, or
 * the source unit already contained it — an author's quotation, a name, a line
 * of a foreign alphabet — and a translation is allowed to carry that through.
 * Anything else, above a tenth of the letters, is the model answering in a
 * language nobody asked for.
 */
export function foreignScript(
  source: string, translated: string, targetLanguage: string,
  /**
   * `minLetters` is the floor below which there is nothing to judge. It
   * protects a paragraph whose four letters are a product name; a term is
   * short by nature and the whole of it is the evidence, so whoever asks
   * about one lowers it.
   */
  options: { minLetters?: number } = {},
): string | null {
  const expected = scriptsWritingIn(targetLanguage);
  if (expected === null) return null;

  const found = scriptsOf(translated);
  const letters = [...found.values()].reduce((sum, n) => sum + n, 0);
  if (letters < (options.minLetters ?? MIN_LETTERS)) return null;

  const inSource = scriptsOf(source);
  let worst: { script: string; count: number } | null = null;
  for (const [script, count] of found) {
    if (expected.has(script) || inSource.has(script)) continue;
    if (count / letters < SHARE) continue;
    if (worst === null || count > worst.count) worst = { script, count };
  }
  return worst === null ? null : worst.script;
}
