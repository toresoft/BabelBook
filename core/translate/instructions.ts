import type { TranslationRequest } from "./types.ts";

/**
 * The rules the translation is held to, and the shape it must arrive in.
 *
 * The format half is not decoration. It is the contract: without it a valid
 * answer is a lucky accident, and the accident does not happen. A model asked
 * to "answer in the format you are given" reads the payload as a document
 * rather than a record, translates it well, and hands back prose — which the
 * parser cannot attribute to any unit, so every unit in the chunk falls back
 * to its untranslated source while the bill is paid in full.
 *
 * So the format is stated here rather than implied: the header, the marker,
 * the terminator, the count, and a whole worked example. The example is the
 * only unambiguous half of the contract, and a test reads it back with the
 * engine's own parser so it cannot drift away from what that parser accepts.
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
    "Format. This is a contract, not a preference. Your answer is read by a",
    "parser: an answer without the block described below cannot be attributed",
    "to any unit and is discarded whole, however good the translation in it is.",
    "",
    "Reply with the block and nothing around it: a header line `UNITS <n>`,",
    "then, for each unit, its `[u:<id>]` marker alone on its own line with the",
    "translation on the lines beneath it, and a closing line `END`.",
    "",
    "`<n>` is how many units you translated, and must equal how many you were",
    "asked for. Copy each `[u:<id>]` marker exactly as it arrives, in the same",
    "order: never invent one, never merge two units into one, never omit one.",
    "The markers are what say which translation belongs to which unit, and",
    "nothing else does — position is not enough, and neither is order.",
    "",
    "A complete answer for two units looks exactly like this:",
    "",
    "UNITS 2",
    "[u:chapter1.xhtml#4]",
    "The translation of the first unit.",
    "[u:chapter1.xhtml#5]",
    "The translation of the second unit, which may",
    "run to several lines.",
    "END",
    "",
    "Rules:",
    "- Reproduce every numbered placeholder exactly as it arrives, in the same",
    "  order and balanced: <0>text</0> stays <0>…</0>, <1/> stays <1/>.",
    "- Never translate what sits inside an empty placeholder pair: it holds code.",
    "- Reproduce unchanged any command, code snippet, console session or program",
    "  output that carries no markup of its own. A book may contain them in plain",
    "  paragraphs, and translating them breaks them silently.",
    "- Keep the author's register and tense. Do not explain, expand or summarise.",
    "- Write no preface and no commentary: the block is the whole answer.",
  ].join("\n");
}
