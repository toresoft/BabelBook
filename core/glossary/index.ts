/** Public surface of the glossary layer. */

export type { TermEntry } from "./types.ts";
export { GlossaryError, parseGlossary, serializeGlossary } from "./parse.ts";
export type { Glossary } from "./parse.ts";

import type { Glossary } from "./parse.ts";

/** The primary subtag, which is what "the same language" means here. */
function primary(tag: string): string {
  return tag.split("-")[0]!.toLowerCase();
}

/**
 * `name@version` for each glossary, sorted.
 *
 * Sorted because the set is what matters, never the order it was loaded in:
 * the cache key is built from this, and a key that moved with the load order
 * would throw away good work for nothing.
 */
export function glossaryIdentity(glossaries: Glossary[]): string[] {
  return glossaries.map((g) => `${g.name}@${g.version}`).sort();
}

/**
 * Whether a glossary speaks the pair a run needs.
 *
 * Compared by primary subtag: a package declaring `en-US` and a glossary
 * written for `en` are the same language for terminology, and treating them as
 * different silently drops the glossary.
 */
export function supportsLanguages(glossary: Glossary, from: string, to: string): boolean {
  return primary(glossary.sourceLanguage) === primary(from)
    && primary(glossary.targetLanguage) === primary(to);
}
