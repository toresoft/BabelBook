import type { DatabaseSync } from "node:sqlite";
import { unitsAffectedByTerms } from "../../../core/translate/terms.ts";
import type { TermEntry } from "../../../core/glossary/index.ts";
import type { TranslationUnit } from "../../../core/epub/index.ts";
import type { InvalidationPreview } from "../../shared/dto.ts";
import { estimate } from "../../shared/estimate.ts";

export type { InvalidationPreview } from "../../shared/dto.ts";

const WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;

/**
 * What a change in terminology would undo, before it undoes it.
 *
 * The preview is the whole point of the feature. The user edits a term after
 * a run has started; the screen answers "this retranslates 34 units, about so
 * many tokens" and *then* asks. The prototype threw away the entire session at
 * every change of configuration, and the cost of that decision arrived on the
 * invoice rather than on the screen.
 *
 * The matching is the core's, not a second implementation of it: `listTerms`
 * counts occurrences the same way for the same reason. A preview that
 * disagreed with the invalidation it authorises would be worse than none.
 */
export function previewInvalidation(
  db: DatabaseSync, projectId: string, changedTermIds: string[],
): InvalidationPreview {
  if (changedTermIds.length === 0) return { units: [], cost: null };

  const placeholders = changedTermIds.map(() => "?").join(",");
  const terms = db.prepare(
    `SELECT source, target, rule, origin FROM term WHERE project_id = ? AND id IN (${placeholders})`,
  ).all(projectId, ...changedTermIds) as unknown as Array<{
    source: string; target: string | null; rule: TermEntry["rule"]; origin: string | null;
  }>;

  const changed: TermEntry[] = terms.map((term) => ({
    source: term.source,
    ...(term.target === null ? {} : { target: term.target }),
    rule: term.rule,
    origin: (term.origin ?? "extracted") as TermEntry["origin"],
  }));

  const rows = db.prepare(
    "SELECT unit_id, source_text FROM unit WHERE project_id = ?",
  ).all(projectId) as unknown as Array<{ unit_id: string; source_text: string }>;

  // `unitsAffectedByTerms` reads only `id` and `source`; the rest of the shape
  // would be dead weight to build from SQL for a question that never looks at
  // it, so the cast says so rather than inventing ranges and kinds.
  const units = rows.map((row) => ({ id: row.unit_id, source: row.source_text })) as TranslationUnit[];
  const affected = unitsAffectedByTerms(units, changed);
  if (affected.length === 0) return { units: [], cost: null };

  const touched = new Set(affected);
  const words = rows
    .filter((row) => touched.has(row.unit_id))
    .reduce((total, row) => total + (row.source_text.match(WORD)?.length ?? 0), 0);

  // Tokens only. The price belongs to the model the project is configured
  // with, and this module does not know it — an invented figure would be
  // believed, which is worse than a missing one.
  const { tokensIn, tokensOut } = estimate({ words, priceIn: null, priceOut: null });
  return { units: affected, cost: { tokensIn, tokensOut } };
}

/**
 * Drops the translations of the named units under one cache key.
 *
 * Scoped to the project as well as to the unit id, because a unit id is
 * `${doc}#${ordinal}` and only unique within a book: two projects both having
 * a `c1.xhtml#1` is the ordinary case. Scoped to the key because the same unit
 * under another key belongs to a different configuration, and that is not this
 * change's business.
 */
export function applyInvalidation(
  db: DatabaseSync, projectId: string, unitIds: string[], cacheKey: string,
): { removed: number } {
  if (unitIds.length === 0) return { removed: 0 };

  const placeholders = unitIds.map(() => "?").join(",");
  const removed = db.prepare(`
    DELETE FROM translation
     WHERE cache_key = ?
       AND unit_id IN (
         SELECT id FROM unit WHERE project_id = ? AND unit_id IN (${placeholders})
       )
  `).run(cacheKey, projectId, ...unitIds).changes;

  return { removed: Number(removed) };
}
