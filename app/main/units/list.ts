import type { DatabaseSync } from "node:sqlite";
import type { UnitQuery, UnitRow } from "../../shared/dto.ts";
import { displayText } from "./display.ts";

export type { UnitQuery, UnitRow } from "../../shared/dto.ts";

interface Row {
  unit_id: string;
  zip_path: string;
  ordinal: number;
  effective: string;
  forced_state: string | null;
  reason: string | null;
  source_text: string;
  raw_text: string | null;
  translation: string | null;
  outcome: string | null;
}

/** A page is a screenful, not a book: the default keeps one query cheap. */
const DEFAULT_LIMIT = 100;

/**
 * The units of a book, each beside whatever has been made of it.
 *
 * This is the tab with which a book is actually checked, and the prototype had
 * nothing like it: a translation could only be judged by opening the finished
 * EPUB and reading it, which is too late to change anything.
 *
 * Filtering reads `coalesce(forced_state, state)` because that is the state
 * that acts — the planner reads it too. Filtering on the deduced state would
 * hide a block the user freed from the very list they freed it in.
 */
export function listUnits(
  db: DatabaseSync, projectId: string, query: UnitQuery,
): { units: UnitRow[]; total: number } {
  const state = query.state ?? null;
  const search = query.search === undefined || query.search.trim() === ""
    ? null
    : `%${query.search.trim()}%`;

  const where = `
     WHERE u.project_id = ?
       AND (? IS NULL OR coalesce(u.forced_state, u.state) = ?)
       AND (? IS NULL OR u.source_text LIKE ? OR coalesce(t.text, '') LIKE ?)
  `;
  const from = `
      FROM unit u
      JOIN project_document d ON d.id = u.document_id
      LEFT JOIN translation t ON t.unit_id = u.id
       AND t.cache_key = coalesce(
             (SELECT p.cache_key FROM project p WHERE p.id = u.project_id), t.cache_key)
  `;
  const args = [projectId, state, state, search, search, search];

  const counted = db.prepare(`SELECT count(*) AS n ${from} ${where}`).get(...args) as { n: number };

  const rows = db.prepare(`
    SELECT u.unit_id, d.zip_path, u.ordinal,
           coalesce(u.forced_state, u.state) AS effective,
           u.forced_state, u.reason, u.source_text, u.raw_text,
           t.text AS translation, t.outcome
    ${from} ${where}
     ORDER BY d.spine_order, u.ordinal
     LIMIT ? OFFSET ?
  `).all(...args, query.limit ?? DEFAULT_LIMIT, query.offset ?? 0) as unknown as Row[];

  return {
    total: Number(counted.n),
    units: rows.map((row) => ({
      unitId: row.unit_id,
      doc: row.zip_path,
      ordinal: Number(row.ordinal),
      state: row.effective,
      forced: row.forced_state !== null,
      reason: row.reason,
      source: displayText(row.raw_text, row.source_text),
      translation: row.translation,
      outcome: row.outcome,
    })),
  };
}
