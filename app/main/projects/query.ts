import type { DatabaseSync } from "node:sqlite";
import type { LayoutKind, ProjectSummary } from "../../shared/dto.ts";
import { coverUrl } from "../protocol.ts";

interface SummaryRow {
  id: string;
  title: string;
  author: string | null;
  cover_file: string | null;
  source_language: string | null;
  target_language: string;
  state: string;
  layout: string | null;
  created_at: string;
  total: number;
  done: number;
}

/**
 * The library, in one query.
 *
 * The progress could be a second query per project, and it would look fine
 * with three projects. It would slow down as the library grows and the defect
 * would arrive months later, when there are thirty — so the counts are
 * sub-selects and the whole screen costs one round trip.
 *
 * `done` counts translations under the project's *current* cache key only.
 * Work made under another configuration is real, but it is not progress
 * towards this one, and showing it would promise a book that is not there.
 *
 * Distinct units, not rows: the same unit can hold a translation under several
 * keys, and counting rows would report a book more finished than it is — the
 * one direction a progress bar must never err in.
 */
export function listProjects(db: DatabaseSync, filter?: string): ProjectSummary[] {
  const pattern = filter === undefined || filter.trim() === "" ? null : `%${filter.trim()}%`;

  const rows = db.prepare(`
    SELECT p.id, p.title, p.author, p.cover_file, p.source_language, p.target_language,
           p.state, p.layout, p.created_at,
           (SELECT count(*) FROM unit u
             WHERE u.project_id = p.id
               AND coalesce(u.forced_state, u.state) IN ('translate', 'maybe-code')) AS total,
           (SELECT count(DISTINCT u.id) FROM translation t
              JOIN unit u ON u.id = t.unit_id
             WHERE u.project_id = p.id
               AND coalesce(u.forced_state, u.state) IN ('translate', 'maybe-code')
               AND t.cache_key = coalesce(p.cache_key, t.cache_key)) AS done
      FROM project p
     WHERE (? IS NULL OR lower(p.title) LIKE lower(?))
     ORDER BY p.created_at DESC, p.title ASC
  `).all(pattern, pattern) as unknown as SummaryRow[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    ...(row.author === null ? {} : { author: row.author }),
    coverPath: row.cover_file === null ? null : coverUrl(row.id, row.cover_file),
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    state: row.state,
    progress: { done: row.done, total: row.total },
    layout: (row.layout ?? "reflowable") as LayoutKind,
    createdAt: row.created_at,
  }));
}
