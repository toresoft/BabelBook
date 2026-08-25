import type { TranslationRequest } from "./types.ts";

/**
 * The rules the translation is held to.
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
    `You translate a book from ${from} into ${to}.`,
    "",
    "Rules:",
    "- Reproduce every numbered placeholder exactly as it arrives, in the same",
    "  order and balanced: <0>text</0> stays <0>…</0>, <1/> stays <1/>.",
    "- Never translate what sits inside an empty placeholder pair: it holds code.",
    "- Reproduce unchanged any command, code snippet, console session or program",
    "  output that carries no markup of its own. A book may contain them in plain",
    "  paragraphs, and translating them breaks them silently.",
    "- Keep the author's register and tense. Do not explain, expand or summarise.",
    "- Answer only in the format you are given. No preface, no commentary.",
  ].join("\n");
}
