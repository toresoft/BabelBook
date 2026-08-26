import type { DatabaseSync } from "node:sqlite";
import type { LayoutKind, ProjectDetail } from "../../shared/dto.ts";
import { coverUrl } from "../protocol.ts";
import { makeMachineHost } from "../run/machine-host.ts";

export type { ProjectDetail } from "../../shared/dto.ts";

interface DetailRow {
  id: string;
  title: string;
  author: string | null;
  cover_file: string | null;
  description: string | null;
  source_language: string | null;
  target_language: string;
  state: string;
  layout: string | null;
  has_overlays: number;
  provider_id: string | null;
  model_id: string | null;
  created_at: string;
  total: number;
  done: number;
  tokens_in: number;
  tokens_out: number;
  /** Null when any contributing run was never priced: see `cost` below. */
  cost: number | null;
}

/**
 * One project, as its own screen needs it.
 *
 * The counts follow the library's rule exactly: work is what will be
 * translated under the *current* cache key, counted in distinct units. Two
 * screens disagreeing about how far along a book is would be worse than
 * either of them being wrong.
 */
export function projectDetail(db: DatabaseSync, projectId: string): ProjectDetail | null {
  const row = db.prepare(`
    SELECT p.id, p.title, p.author, p.cover_file, p.description,
           p.source_language, p.target_language, p.state, p.layout, p.has_overlays,
           p.provider_id, p.model_id, p.created_at,
           (SELECT count(*) FROM unit u
             WHERE u.project_id = p.id
               AND coalesce(u.forced_state, u.state) IN ('translate', 'maybe-code')) AS total,
           (SELECT count(DISTINCT u.id) FROM translation t
              JOIN unit u ON u.id = t.unit_id
             WHERE u.project_id = p.id
               AND coalesce(u.forced_state, u.state) IN ('translate', 'maybe-code')
               AND t.cache_key = coalesce(p.cache_key, t.cache_key)) AS done,
           coalesce((SELECT sum(r.tokens_in) FROM run r WHERE r.project_id = p.id), 0) AS tokens_in,
           coalesce((SELECT sum(r.tokens_out) FROM run r WHERE r.project_id = p.id), 0) AS tokens_out,
           (SELECT sum(r.cost) FROM run r WHERE r.project_id = p.id
             AND NOT EXISTS (SELECT 1 FROM run r2 WHERE r2.project_id = p.id AND r2.cost IS NULL)) AS cost
      FROM project p
     WHERE p.id = ?
  `).get(projectId) as unknown as DetailRow | undefined;
  if (row === undefined) return null;

  return {
    id: row.id,
    title: row.title,
    ...(row.author === null ? {} : { author: row.author }),
    coverPath: row.cover_file === null ? null : coverUrl(row.id, row.cover_file),
    description: row.description,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    state: row.state,
    progress: { done: Number(row.done), total: Number(row.total) },
    layout: (row.layout ?? "reflowable") as LayoutKind,
    hasOverlays: row.has_overlays === 1,
    providerId: row.provider_id,
    modelId: row.model_id,
    createdAt: row.created_at,
    // Asked of the machine, never derived from the state name.
    actions: makeMachineHost(db, projectId, {
      hasLanguage: row.source_language !== null,
    }).allows,
    tokens: { in: Number(row.tokens_in), out: Number(row.tokens_out) },
    // The subquery yields null when any run is unpriced, which is the only
    // honest thing to show then: not a smaller number that reads like a total.
    cost: row.cost === null ? null : Number(row.cost),
  };
}
