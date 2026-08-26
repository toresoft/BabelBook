import type { DatabaseSync } from "node:sqlite";
import type { TranslationUnit } from "../../../core/epub/index.ts";
import type { TermEntry } from "../../../core/glossary/index.ts";
import { measureAdherence } from "../../../core/translate/terms.ts";
import type { Adherence, Report, ReportLine } from "../../shared/dto.ts";
import type { ComposeResult } from "../compose.ts";

export type { Report, ReportLine } from "../../shared/dto.ts";

/** Above this share of identical translations, something is wrong. */
const IDENTICAL_WARNING = 0.05;
/** Enough to recognise a pattern, few enough not to be a second copy of the log. */
const SAMPLES = 5;

interface EventRow {
  code: string;
  severity: ReportLine["severity"];
  count: number;
  payloads: string;
}

function lines(db: DatabaseSync, runId: string, degradations: boolean): ReportLine[] {
  const rows = db.prepare(`
    SELECT code, severity, count(*) AS count,
           json_group_array(payload_json) AS payloads
      FROM run_event
     WHERE run_id = ? AND (severity = 'degradation') = ?
     GROUP BY code, severity
     ORDER BY count DESC, code
  `).all(runId, degradations ? 1 : 0) as unknown as EventRow[];

  return rows.map((row) => ({
    code: row.code,
    severity: row.severity,
    count: Number(row.count),
    samples: (JSON.parse(row.payloads) as string[])
      .slice(0, SAMPLES)
      .map((payload) => {
        try {
          return JSON.parse(payload) as unknown;
        } catch {
          return payload;
        }
      }),
  }));
}

function composeResult(db: DatabaseSync, projectId: string): ComposeResult | null {
  const row = db.prepare(
    "SELECT result_json FROM project_phase_result WHERE project_id = ? AND phase = 'compose'"
      + " ORDER BY created_at DESC LIMIT 1",
  ).get(projectId) as { result_json: string } | undefined;
  if (row === undefined) return null;

  try {
    return JSON.parse(row.result_json) as ComposeResult;
  } catch {
    return null;
  }
}

/**
 * How well the terminology was honoured, measured on what was actually stored.
 *
 * Null when there are no active terms: "no terms" and "every term was
 * honoured" are different facts, and reporting the second for the first would
 * claim a glossary is working when none is in use.
 */
function adherenceOf(db: DatabaseSync, projectId: string, cacheKey: string): {
  active: number;
  adherence: Adherence | null;
} {
  const termRows = db.prepare(
    "SELECT source, target, rule FROM term WHERE project_id = ? AND approval_state = 'approved'",
  ).all(projectId) as unknown as Array<{ source: string; target: string | null; rule: TermEntry["rule"] }>;

  if (termRows.length === 0) return { active: 0, adherence: null };

  const terms: TermEntry[] = termRows.map((row) => ({
    source: row.source,
    ...(row.target === null ? {} : { target: row.target }),
    rule: row.rule,
    origin: "extracted" as const,
  }));

  const pairs = db.prepare(`
    SELECT u.unit_id, u.source_text, t.text
      FROM unit u JOIN translation t ON t.unit_id = u.id
     WHERE u.project_id = ? AND t.cache_key = ?
  `).all(projectId, cacheKey) as unknown as Array<{
    unit_id: string; source_text: string; text: string;
  }>;

  // `measureAdherence` reads a unit's id and source and nothing else; building
  // the rest of the shape from SQL would be dead weight for a question that
  // never looks at it.
  return {
    active: terms.length,
    adherence: measureAdherence(terms, pairs.map((pair) => ({
      unit: { id: pair.unit_id, source: pair.source_text } as TranslationUnit,
      text: pair.text,
    }))),
  };
}

/**
 * What happened to a book, as codes rather than as sentences.
 *
 * The interface composes the phrases from its catalogue, in the reader's
 * language. It is also what makes a report worth comparing: two different
 * books that went wrong the same way produce the same codes.
 *
 * Nothing here recomputes anything. A report that re-ran EPUBCheck or re-read
 * the archive would be a second, slower composition that could disagree with
 * the one the user actually has.
 */
export function buildReport(db: DatabaseSync, projectId: string, runId: string): Report {
  const project = db.prepare(
    "SELECT layout, cache_key, source_sha256 FROM project WHERE id = ?",
  ).get(projectId) as { layout: string | null; cache_key: string | null; source_sha256: string } | undefined;
  if (project === undefined) throw new Error(`no such project: ${projectId}`);

  const cacheKey = project.cache_key ?? project.source_sha256;

  const counts = db.prepare(`
    SELECT count(*) AS total,
           sum(CASE WHEN t.outcome IS NOT NULL THEN 1 ELSE 0 END) AS translated,
           sum(CASE WHEN t.outcome = 'identical' THEN 1 ELSE 0 END) AS identical,
           sum(CASE WHEN t.outcome = 'fell-back' THEN 1 ELSE 0 END) AS fellBack
      FROM unit u
      LEFT JOIN translation t ON t.unit_id = u.id AND t.cache_key = ?
     WHERE u.project_id = ?
  `).get(cacheKey, projectId) as {
    total: number; translated: number | null; identical: number | null; fellBack: number | null;
  };

  const notTranslatedRows = db.prepare(`
    SELECT coalesce(forced_state, state) AS state, count(*) AS count
      FROM unit
     WHERE project_id = ? AND coalesce(forced_state, state) <> 'translate'
     GROUP BY coalesce(forced_state, state)
  `).all(projectId) as unknown as Array<{ state: string; count: number }>;

  const notTranslated: Record<string, number> = {};
  for (const row of notTranslatedRows) notTranslated[row.state] = Number(row.count);

  const total = Number(counts.total);
  const translated = Number(counts.translated ?? 0);
  const identical = Number(counts.identical ?? 0);
  const fellBack = Number(counts.fellBack ?? 0);

  const run = db.prepare("SELECT tokens_in, tokens_out, cost FROM run WHERE id = ?").get(runId) as
    { tokens_in: number; tokens_out: number; cost: number | null } | undefined;

  const degradations = lines(db, runId, true);
  const compose = composeResult(db, projectId);
  const prePaginated = db.prepare(
    "SELECT count(*) AS n FROM unit WHERE project_id = ? AND state = 'uncomposable'",
  ).get(projectId) as { n: number };

  const status: Report["status"] = compose?.status === "failed"
    ? "failed"
    : degradations.length > 0 || compose?.status === "incomplete" ? "incomplete" : "complete";

  return {
    status,
    units: { total, translated, fellBack, identical, notTranslated },
    identicalWarning: translated > 0 && identical / translated > IDENTICAL_WARNING,
    degradations,
    declarations: lines(db, runId, false),
    invariants: compose?.invariants ?? [],
    epubcheck: {
      ran: compose?.epubcheck.ran ?? false,
      ...(compose?.epubcheck.reason === undefined ? {} : { reason: compose.epubcheck.reason }),
      introduced: compose?.epubcheck.messages ?? [],
    },
    layout: { book: project.layout ?? "reflowable", prePaginated: Number(prePaginated.n) },
    overlaysRemoved: compose?.overlaysRemoved ?? { overlays: 0, audio: 0 },
    terms: adherenceOf(db, projectId, cacheKey),
    cost: {
      tokensIn: Number(run?.tokens_in ?? 0),
      tokensOut: Number(run?.tokens_out ?? 0),
      amount: run?.cost ?? null,
    },
    outputPath: compose?.outputPath ?? null,
  };
}
