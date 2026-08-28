import type { DatabaseSync } from "node:sqlite";
import type { ProjectState } from "../../../core/workflow/project.machine.ts";
import type { LayoutKind, ProjectSummary } from "../../shared/dto.ts";
import { BUCKETS, statesOf, type Bucket } from "../../shared/buckets.ts";
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
export interface LibraryQuery {
  search?: string;
  bucket?: Bucket;
}

export function listProjects(db: DatabaseSync, query: LibraryQuery = {}): ProjectSummary[] {
  const search = query.search?.trim() ?? "";
  const pattern = search === "" ? null : `%${search}%`;

  // The group is a list of states, expanded into placeholders: filtering in
  // the renderer would ship the whole library on every click and keep two
  // truths about one set.
  const states = statesOf(query.bucket ?? "all");
  const holes = states.map(() => "?").join(",");
  const clause = states.length === 0 ? "" : ` AND p.state IN (${holes})`;

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
     WHERE (? IS NULL OR lower(p.title) LIKE lower(?))${clause}
     ORDER BY p.created_at DESC, p.title ASC
  `).all(pattern, pattern, ...states) as unknown as SummaryRow[];

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

/**
 * How many projects each group holds, in one query.
 *
 * The column shows five numbers and the library may be long, so the states are
 * counted by the database and grouped here — never eleven queries, and never
 * the whole library shipped to be counted in the window.
 */
export function countProjects(db: DatabaseSync): Record<Bucket, number> {
  const rows = db.prepare("SELECT state, count(*) AS n FROM project GROUP BY state")
    .all() as Array<{ state: ProjectState; n: number }>;

  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const row of rows) {
    counts.all += row.n;
    for (const bucket of BUCKETS) {
      if (bucket !== "all" && statesOf(bucket).includes(row.state)) counts[bucket] += row.n;
    }
  }
  return counts;
}
