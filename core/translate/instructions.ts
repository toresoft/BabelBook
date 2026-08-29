import type { TranslationRequest } from "./types.ts";

/**
 * The rules the translation is held to, and the shape it must arrive in.
 *
 * The format is not decoration. Without it a valid answer is a lucky accident:
 * a model asked to "answer in the format you are given" reads the payload as a
 * document rather than a record, translates it well, and hands back prose the
 * parser cannot attribute to any unit — so every unit in the chunk falls back
 * to source while the bill is paid in full. That is why the example is here
 * whole, and why a test reads it back with the engine's own parser.
 *
 * But the format cannot be most of what is said. Version 2 was 1631
 * characters, 78% of them protocol and 47 of them the work, with the only
 * mention of the language on the first line and every line after it about
 * markers. A model that spent its attention accordingly answered one book in
 * three in Chinese, with the protocol obeyed to the letter. So the rules are
 * stated once and briefly, the example carries what prose would have to
 * belabour, and the work is said twice — first and last, the two positions a
 * model reads hardest.
 *
 * Whoever edits this file raises `PROMPT_VERSION` in the same commit: these
 * words are part of the contract a translation was produced under, and a
 * cache that outlived them would reuse work made under different rules.
 */

const NAMES: Record<string, string> = {
  en: "English", it: "Italian", fr: "French", de: "German", es: "Spanish",
  pt: "Portuguese", nl: "Dutch", sv: "Swedish", pl: "Polish", ru: "Russian",
};

/** The language's English name when we know it, the tag itself when we do not. */
export function languageName(tag: string): string {
  return NAMES[tag.split("-")[0]!.toLowerCase()] ?? tag;
}

export function buildSystem(request: TranslationRequest): string {
  const from = languageName(request.context.sourceLanguage);
  const to = languageName(request.context.targetLanguage);

  return [
    `You are translating a book from ${from} into ${to}. Every unit you are`,
    `given must come back written in ${to}.`,
    "",
    "- Reproduce every numbered placeholder exactly, in the same order and",
    "  balanced: <0>text</0> stays <0>…</0>, <1/> stays <1/>.",
    "- Never translate what sits inside an empty placeholder pair: it holds code.",
    "- Reproduce unchanged any command, code snippet, console session or program",
    "  output that carries no markup of its own: translating one breaks it.",
    "- Keep the author's register and tense. Do not explain, expand or summarise.",
    "",
    "Answer with this block and nothing around it. Copy each `[u:<id>]` marker",
    "exactly as it arrives: the markers say which translation belongs to which",
    "unit, and an answer without the block is discarded whole.",
    "",
    "UNITS 2",
    "[u:chapter1.xhtml#4]",
    "The translation of the first unit.",
    "[u:chapter1.xhtml#5]",
    "The translation of the second unit, which may",
    "run to several lines.",
    "END",
    "",
    `Now translate, into ${to}.`,
  ].join("\n");
}
