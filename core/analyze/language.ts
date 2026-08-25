import type { LlmBackend } from "../ports.ts";
import type { TranslationUnit } from "../epub/index.ts";
import { sampleBlocks } from "./sample.ts";

export interface LanguageVerdict {
  /** Null when nobody decided: the interface must ask. */
  language: string | null;
  method: "declared" | "voted" | "conflict" | "abstained" | "no-backend";
  /** What the package said, when it said anything usable. */
  declared?: string;
  /** What the model said, when it was asked. */
  voted?: string;
  needsConfirmation: boolean;
}

export interface DetectInput {
  declared: string | null;
  units: TranslationUnit[];
  backend: LlmBackend | null;
  /**
   * Ask the model even though the package declared something.
   *
   * Off by default, because a declared language is normally right and a vote
   * costs money on every book. The interface turns it on when the user says
   * the declaration looks wrong — which is the only way a `conflict` verdict
   * can arise, since otherwise nobody ever asks a second opinion.
   */
  verifyDeclared?: boolean;
  signal?: AbortSignal;
}

/** A well-formed BCP 47 tag. `und` is well-formed and says nothing, so it is not one. */
const TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

function plausible(tag: string | null): tag is string {
  if (tag === null) return false;
  const trimmed = tag.trim();
  return TAG.test(trimmed) && primary(trimmed) !== "und" && primary(trimmed) !== "mul";
}

/** The primary subtag: `en-US` and `en` are one language for our purposes. */
function primary(tag: string): string {
  return tag.trim().split("-")[0]!.toLowerCase();
}

/**
 * A language code, or nothing.
 *
 * A sample whose answer is prose rather than a code is discarded, not mined
 * for a word that looks like a language: "I would say this is English" and
 * "not English" both contain the same word.
 */
function readAnswer(raw: string): string | null {
  const cleaned = raw.trim().replace(/^["'`]+|["'`.\s]+$/g, "");
  return TAG.test(cleaned) ? primary(cleaned) : null;
}

function buildPrompt(sample: string[]): string {
  return [
    "Identify the language of the following book passage.",
    "Answer with a BCP 47 language code and nothing else, for example: en",
    "",
    "---",
    sample.join("\n"),
    "---",
  ].join("\n");
}

/**
 * Which language a book is written in, at the least possible cost.
 *
 * The package comes first and usually settles it: reading `dc:language` costs
 * nothing and needs no provider, so a book that declares one is decided before
 * any network exists. The model is asked only when the declaration is missing
 * or says nothing (`und`), or when the caller explicitly wants it checked.
 *
 * Nothing here decides on the user's behalf when the sources disagree. Quietly
 * overruling a publisher's declaration with a model's opinion is the kind of
 * initiative that surfaces once the whole book is translated.
 */
export async function detectLanguage(input: DetectInput): Promise<LanguageVerdict> {
  const declared = plausible(input.declared) ? primary(input.declared) : null;

  if (declared !== null && input.verifyDeclared !== true) {
    return { language: declared, method: "declared", declared, needsConfirmation: false };
  }

  const base = declared === null ? {} : { declared };

  if (input.backend === null) {
    return { language: null, method: "no-backend", ...base, needsConfirmation: true };
  }

  const samples = sampleBlocks(input.units);
  const answers: string[] = [];
  for (const sample of samples) {
    input.signal?.throwIfAborted();
    const result = await input.backend.call({
      prompt: buildPrompt(sample),
      maxOutputTokens: 16,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const answer = readAnswer(result.text);
    if (answer !== null) answers.push(answer);
  }

  const counted = new Map<string, number>();
  for (const answer of answers) counted.set(answer, (counted.get(answer) ?? 0) + 1);

  let voted: string | null = null;
  for (const [language, votes] of counted) {
    if (votes > samples.length / 2) voted = language;
  }

  if (voted === null) {
    return { language: null, method: "abstained", ...base, needsConfirmation: true };
  }
  if (declared !== null && declared !== voted) {
    return { language: null, method: "conflict", declared, voted, needsConfirmation: true };
  }
  return { language: voted, method: "voted", ...base, voted, needsConfirmation: false };
}
