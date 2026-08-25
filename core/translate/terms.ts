import type { TermEntry } from "../glossary/index.ts";
import type { TranslationUnit } from "../epub/index.ts";

export interface Violation {
  unitId: string;
  term: string;
  rule: TermEntry["rule"];
}

export interface Adherence {
  checked: number;
  respected: number;
  /**
   * Counted per rule, because the rules are not a scale.
   *
   * Disregarding a `prefer` can be the right call — grammar and rhythm push
   * back, and the glossary said "recommended", not "required". Disregarding a
   * `must` is a defect. Adding them together produces a number that means
   * nothing and that nobody can act on.
   */
  byRule: Record<TermEntry["rule"], { checked: number; respected: number }>;
  violations: Violation[];
}

/**
 * The active terminology: the project's terms win.
 *
 * Whoever decided a term on this book had the book in front of them; whoever
 * wrote the glossary had a genre in mind. On a disagreement the closer view
 * is the better one.
 */
export function mergeTerms(glossaryTerms: TermEntry[], projectTerms: TermEntry[]): TermEntry[] {
  const merged = new Map<string, TermEntry>();
  for (const term of glossaryTerms) merged.set(term.source, term);
  for (const term of projectTerms) merged.set(term.source, term);
  return [...merged.values()];
}

/**
 * Only the terms a chunk actually contains.
 *
 * Sending a whole glossary with every chunk costs tokens on every call and
 * gives the model a hundred rules to weigh where two apply. A rule that cannot
 * fire is a distraction with a price.
 */
export function termsForChunk(terms: TermEntry[], units: TranslationUnit[]): TermEntry[] {
  const text = units.map((unit) => unit.source).join("\n");
  return terms.filter((term) => text.includes(term.source));
}

/**
 * How far the translation followed the terminology it was given.
 *
 * A measure, not a gate. A violation does not trigger a retry: a `must` can
 * legitimately fail to surface in a sentence that restructures it, and
 * retranslating on that suspicion would spend money on grammar. What the
 * number answers is whether the glossary is working at all — a book with
 * forty violations is telling you the terminology is not reaching the model.
 */
export function measureAdherence(
  terms: TermEntry[],
  pairs: Array<{ unit: TranslationUnit; text: string }>,
): Adherence {
  const byRule: Adherence["byRule"] = {
    dnt: { checked: 0, respected: 0 },
    prefer: { checked: 0, respected: 0 },
    must: { checked: 0, respected: 0 },
  };
  const violations: Violation[] = [];

  for (const { unit, text } of pairs) {
    for (const term of terms) {
      if (!unit.source.includes(term.source)) continue;

      // `dnt` is respected when the term survived untouched; the other two
      // when their rendering is present. Both are substring checks, which is
      // coarse: it cannot see a term the target language had to inflect. It
      // errs towards reporting a violation, which is the safe direction for
      // a number whose job is to raise a question.
      const respected = term.rule === "dnt"
        ? text.includes(term.source)
        : text.includes(term.target ?? "");

      byRule[term.rule].checked++;
      if (respected) byRule[term.rule].respected++;
      else violations.push({ unitId: unit.id, term: term.source, rule: term.rule });
    }
  }

  const checked = byRule.dnt.checked + byRule.prefer.checked + byRule.must.checked;
  const respected = byRule.dnt.respected + byRule.prefer.respected + byRule.must.respected;

  return { checked, respected, byRule, violations };
}

/**
 * Which units a change in terminology invalidates.
 *
 * This is what makes invalidation selective. When the user edits a term after
 * a run has started, only the units carrying it lose their translation — the
 * rest of the cache stands. The prototype threw away the whole session at
 * every change of configuration, and the cost showed up on the bill.
 */
export function unitsAffectedByTerms(units: TranslationUnit[], changed: TermEntry[]): string[] {
  return units
    .filter((unit) => changed.some((term) => unit.source.includes(term.source)))
    .map((unit) => unit.id);
}
