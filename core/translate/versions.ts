import { createHash } from "node:crypto";

/**
 * The contract a translation was produced under, versioned by hand.
 *
 * Changing the instructions, the window strategy or the identity of a glossary
 * changes what a translation means. If the key did not move with them, a
 * resumed run would reuse work made under a different contract — silently, and
 * nobody would find it by reading the book.
 *
 * Whoever edits `instructions.ts` raises `PROMPT_VERSION` in the same commit;
 * whoever edits `plan.ts`'s context window raises `CONTEXT_VERSION`.
 *
 * 2: the instructions state the format contract — the header, the marker, the
 * terminator, the count, and a worked example — instead of asking for "the
 * format you are given" and naming none of it. Under version 1 a model that
 * translated perfectly answered in prose, and every unit fell back to source;
 * nothing produced under it is worth reusing, which is what this bump says.
 */
export const PROMPT_VERSION = 2;
export const CONTEXT_VERSION = 1;

/**
 * 2: the pass asks the translator's question — would you translate this line
 * or retype it — instead of a classifier's, judges the whole line, carries the
 * element and class beside the text, and flattens each block onto one line.
 * Under version 1, measured on a real book by the prototype this came from,
 * the model called 432 blocks code, at least 86 of them plain prose.
 *
 * It does NOT go into `cacheKey`. The code index is keyed separately, because
 * a translation was not produced by this question and must not be thrown away
 * when this question is corrected.
 */
export const CODE_INDEX_VERSION = 2;

export interface CacheKeyInput {
  /**
   * The book the translation was made from.
   *
   * Everything else here describes how the work was done; this says what it
   * was done to. A source replaced under a project that keeps its id is a
   * different book, and its unit ids collide with the old one's.
   */
  sourceSha256: string;
  /** The model spec as it was written, verbatim: it is part of the identity. */
  modelId: string;
  /**
   * Whether the model was asked to reason, resolved — the route's default
   * already applied.
   *
   * Resolved rather than as chosen, so two configurations that call the model
   * the same way produce the same key even when one says it and the other
   * leaves it implied.
   */
  reasoning: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  /** `name@version` for every active glossary, in any order. */
  glossaries: string[];
}

export interface Versions {
  prompt: number;
  context: number;
}

/**
 * The key under which a translation may be reused.
 *
 * The glossaries are sorted, so the same set always reads the same however it
 * was loaded, and the whole input is JSON-encoded rather than joined with a
 * separator: a glossary named `a@1","b@1` must not be able to produce the key
 * of the two-glossary set, and any separator we could pick is a character a
 * name is allowed to contain.
 */
export function cacheKey(
  input: CacheKeyInput,
  versions: Versions = { prompt: PROMPT_VERSION, context: CONTEXT_VERSION },
): string {
  const canonical = JSON.stringify({
    prompt: versions.prompt,
    context: versions.context,
    source: input.sourceSha256,
    model: input.modelId,
    reasoning: input.reasoning,
    from: input.sourceLanguage,
    to: input.targetLanguage,
    glossaries: [...input.glossaries].sort(),
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
