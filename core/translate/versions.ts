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
 */
export const PROMPT_VERSION = 1;
export const CONTEXT_VERSION = 1;

export interface CacheKeyInput {
  /** The model spec as it was written, verbatim: it is part of the identity. */
  modelId: string;
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
    model: input.modelId,
    from: input.sourceLanguage,
    to: input.targetLanguage,
    glossaries: [...input.glossaries].sort(),
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
