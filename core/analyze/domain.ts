import type { LlmBackend } from "../ports.ts";
import type { Glossary } from "../glossary/index.ts";
import type { TranslationUnit } from "../epub/index.ts";
import { sampleBlocks } from "./sample.ts";

export interface DomainVerdict {
  glossary: string | null;
  /**
   * `abstained` means nobody could decide; `none-applies` means the vote
   * decided that no glossary fits. Keeping them apart matters: the first is a
   * question still open, the second is an answer, and re-asking it next run
   * would spend money to hear the same thing.
   */
  method: "majority" | "none-applies" | "abstained" | "no-glossaries" | "disabled" | "user";
  /** What each sample answered, for the report. */
  votes?: string[];
  /**
   * The names the vote could choose from, sorted.
   *
   * Recorded so a later run can tell "same question, keep the answer" from
   * "new question, ask again": a glossary added since is a different question,
   * even though the book has not changed.
   */
  taxonomy: string[];
}

export interface VoteInput {
  units: TranslationUnit[];
  glossaries: Glossary[];
  backend: LlmBackend;
  signal?: AbortSignal;
}

const NONE = "none";

function buildPrompt(sample: string[], glossaries: Glossary[]): string {
  const options = glossaries
    .map((glossary) => `- ${glossary.name}: ${glossary.description}`)
    .join("\n");

  return [
    "Below is a passage from a book, and a list of terminology glossaries.",
    "Decide which single glossary applies to this book.",
    `Answer with one glossary name, or "${NONE}" if none of them fits.`,
    "Answer with the name alone and nothing else.",
    "",
    "Glossaries:",
    options,
    "",
    "Passage:",
    "---",
    sample.join("\n"),
    "---",
  ].join("\n");
}

/**
 * An answer that is one of the names, or nothing.
 *
 * Prose is discarded rather than searched for a name it happens to contain:
 * "this is not fantasy at all" names `fantasy` and means the opposite.
 */
function readAnswer(raw: string, known: Set<string>): string | null {
  const cleaned = raw.trim().replace(/^["'`]+|["'`.\s]+$/g, "").toLowerCase();
  if (cleaned === NONE) return NONE;
  return known.has(cleaned) ? cleaned : null;
}

/**
 * Which glossary applies to this book, decided by majority over samples that
 * were taken far apart.
 *
 * Abstention is easy and loud on purpose. Wrong terminology at document level
 * is worse than none — the book comes out translated, coherent and wrong — and
 * the failure is silent, so the only cheap control is upstream, on whether the
 * choice was made at all. No majority, an unknown name, an answer that is a
 * sentence: all of them abstain.
 *
 * The verdict binds nobody. The interface shows it, and the user overrides it.
 */
export async function voteDomain(input: VoteInput): Promise<DomainVerdict> {
  const taxonomy = input.glossaries.map((glossary) => glossary.name).sort();
  if (taxonomy.length === 0) {
    return { glossary: null, method: "no-glossaries", taxonomy };
  }

  const known = new Set(taxonomy.map((name) => name.toLowerCase()));
  const samples = sampleBlocks(input.units);
  const votes: string[] = [];

  for (const sample of samples) {
    input.signal?.throwIfAborted();
    const result = await input.backend.call({
      prompt: buildPrompt(sample, input.glossaries),
      maxOutputTokens: 16,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const answer = readAnswer(result.text, known);
    if (answer !== null) votes.push(answer);
  }

  const counted = new Map<string, number>();
  for (const vote of votes) counted.set(vote, (counted.get(vote) ?? 0) + 1);

  let winner: string | null = null;
  for (const [name, count] of counted) {
    if (count > samples.length / 2) winner = name;
  }

  if (winner === null) return { glossary: null, method: "abstained", votes, taxonomy };
  if (winner === NONE) return { glossary: null, method: "none-applies", votes, taxonomy };
  return { glossary: winner, method: "majority", votes, taxonomy };
}
