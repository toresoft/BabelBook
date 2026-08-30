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
  provider_name: string | null;
  model_name: string | null;
  created_at: string;
  total: number;
  done: number;
  tokens_in: number;
  tokens_out: number;
  tokens_reasoning: number;
  /** Null when any contributing run was never priced: see `cost` below. */
  cost: number | null;
  output_path: string | null;
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
               -- A fallback is the unit's own source text: outstanding work,
               -- and the next run asks for it again. Same rule as the library.
               AND t.outcome <> 'fell-back'
               AND t.cache_key = coalesce(p.cache_key, t.cache_key)) AS done,
           coalesce((SELECT sum(r.tokens_in) FROM run r WHERE r.project_id = p.id), 0) AS tokens_in,
           coalesce((SELECT sum(r.tokens_out) FROM run r WHERE r.project_id = p.id), 0) AS tokens_out,
           coalesce((SELECT sum(r.reasoning_tokens) FROM run r WHERE r.project_id = p.id), 0) AS tokens_reasoning,
           (SELECT sum(r.cost) FROM run r WHERE r.project_id = p.id
             AND NOT EXISTS (SELECT 1 FROM run r2 WHERE r2.project_id = p.id AND r2.cost IS NULL)) AS cost,
           -- The same answer the library gives, from the same row: two screens
           -- disagreeing about whether a book has been written would be worse
           -- than either of them being wrong.
           (SELECT json_extract(c.result_json, '$.outputPath')
              FROM project_phase_result c
             WHERE c.project_id = p.id AND c.phase = 'compose'
             ORDER BY c.created_at DESC LIMIT 1) AS output_path,
           (SELECT pr.name FROM provider pr WHERE pr.id = p.provider_id) AS provider_name,
           -- The catalogue's display name when it has one, the model's own id
           -- when it has not: an id is worse than a name and better than blank.
           coalesce(
             (SELECT pm.display_name FROM provider_model pm
               WHERE pm.provider_id = p.provider_id AND pm.model_id = p.model_id),
             p.model_id
           ) AS model_name
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
    outputPath: row.output_path,
    hasOverlays: row.has_overlays === 1,
    providerId: row.provider_id,
    modelId: row.model_id,
    providerName: row.provider_name,
    modelName: row.model_name,
    createdAt: row.created_at,
    // Asked of the machine, never derived from the state name.
    actions: makeMachineHost(db, projectId, {
      hasLanguage: row.source_language !== null,
    }).allows,
    tokens: { in: Number(row.tokens_in), out: Number(row.tokens_out), reasoning: Number(row.tokens_reasoning) },
    // The subquery yields null when any run is unpriced, which is the only
    // honest thing to show then: not a smaller number that reads like a total.
    cost: row.cost === null ? null : Number(row.cost),
  };
}
