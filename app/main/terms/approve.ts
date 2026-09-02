import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TermRow, TermRule } from "../../shared/dto.ts";
import { BabelError } from "../../../core/errors.ts";

export type { TermRow, TermRule } from "../../shared/dto.ts";

/** Thrown with a code, never with a sentence: the interface owns the words. */
export class TermError extends BabelError {
  constructor(code: string, message: string) {
    // `config`: every one of these refuses because of a state somebody can
    // change. Pressing the same button again is never the answer.
    super(`${code}: ${message}`, { code, fault: "config" });
    this.name = "TermError";
  }
}

export interface TermDecision {
  id: string;
  approval: "approved" | "rejected";
  target?: string | null;
  rule?: TermRule;
  note?: string | null;
}

interface Row {
  id: string;
  source: string;
  target: string | null;
  rule: TermRule;
  origin: string | null;
  approval_state: TermRow["approval"];
  sense: string | null;
  note: string | null;
  occurrences: number;
}

const SELECT_TERMS = `
  SELECT t.id, t.source, t.target, t.rule, t.origin, t.approval_state, t.sense, t.note,
         -- Case-sensitive, because unitsAffectedByTerms in the core is, and
         -- the two must agree: a gate that says "appears 4 times" while the
         -- invalidation it authorises touches 2 units is lying to the user
         -- about what they are approving.
         (SELECT count(*) FROM unit u
           WHERE u.project_id = t.project_id
             AND instr(u.source_text, t.source) > 0) AS occurrences
    FROM term t
   WHERE t.project_id = ?
   ORDER BY t.approval_state = 'pending' DESC, t.source
`;

/**
 * The sentence each extracted term came from.
 *
 * It lives in the candidate report rather than on the term, because it belongs
 * to the extraction that proposed it: a term the user typed by hand never had
 * a sentence, and inventing a column for it would fill with nulls.
 */
function contexts(db: DatabaseSync, projectId: string): Map<string, string> {
  const row = db.prepare(`
    SELECT result_json FROM project_phase_result
     WHERE project_id = ? AND phase = 'candidates'
     ORDER BY created_at DESC LIMIT 1
  `).get(projectId) as { result_json: string } | undefined;
  if (row === undefined) return new Map();

  try {
    const report = JSON.parse(row.result_json) as {
      candidates?: Array<{ source: string; context?: string }>;
    };
    return new Map((report.candidates ?? [])
      .filter((candidate) => candidate.context !== undefined)
      .map((candidate) => [candidate.source, candidate.context!]));
  } catch {
    return new Map();
  }
}

function toTerm(row: Row, context: string | null): TermRow {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    rule: row.rule,
    origin: (row.origin ?? "extracted") as TermRow["origin"],
    approval: row.approval_state,
    occurrences: row.occurrences,
    sense: row.sense,
    context,
    note: row.note,
  };
}

/**
 * Every term the project knows, pending ones first.
 *
 * The occurrence count is computed rather than stored: a term the user adds by
 * hand has never been counted by anyone, and a column that only the extraction
 * fills would show it as appearing zero times in a book it appears in.
 */
export function listTerms(db: DatabaseSync, projectId: string): TermRow[] {
  const context = contexts(db, projectId);
  return (db.prepare(SELECT_TERMS).all(projectId) as unknown as Row[])
    .map((row) => toTerm(row, context.get(row.source) ?? null));
}

/**
 * The gate's verdict, all of it or none of it.
 *
 * One transaction because this is a single decision the user made about a
 * screenful of terms: a partial save would leave the gate half-answered, and
 * nothing downstream could tell that apart from a user who approved exactly
 * those and no others.
 *
 * A rejected term stays in the table. Deleting it would let the next analysis
 * propose the same word again, and the user would spend the same attention
 * rejecting the same thing.
 */
export function decideTerms(
  db: DatabaseSync, projectId: string, decisions: TermDecision[],
): { approved: number; rejected: number } {
  const counts = { approved: 0, rejected: 0 };

  db.exec("BEGIN");
  try {
    for (const decision of decisions) {
      const current = db.prepare("SELECT target, rule, note FROM term WHERE id = ? AND project_id = ?")
        .get(decision.id, projectId) as { target: string | null; rule: TermRule; note: string | null } | undefined;
      if (current === undefined) {
        throw new TermError("TERM_UNKNOWN", `no term ${decision.id} in project ${projectId}`);
      }

      db.prepare("UPDATE term SET approval_state = ?, target = ?, rule = ?, note = ? WHERE id = ?").run(
        decision.approval,
        decision.target === undefined ? current.target : decision.target,
        decision.rule ?? current.rule,
        decision.note === undefined ? current.note : decision.note,
        decision.id,
      );
      counts[decision.approval]++;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return counts;
}

/**
 * A term the user typed, born approved.
 *
 * They have just decided it; asking them to approve it afterwards would be a
 * question they already answered.
 */
export function addManualTerm(
  db: DatabaseSync,
  projectId: string,
  term: { source: string; target: string | null; rule: TermRule; sense?: string | null; note: string | null },
): TermRow {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO term (id, project_id, source, target, rule, origin, approval_state, sense, note)
    VALUES (?,?,?,?,?,'manual','approved',?,?)
    ON CONFLICT (project_id, source) DO UPDATE SET
      target = excluded.target, rule = excluded.rule, origin = 'manual',
      approval_state = 'approved', sense = excluded.sense, note = excluded.note
  `).run(id, projectId, term.source, term.target, term.rule, term.sense ?? null, term.note);

  const found = listTerms(db, projectId).find((row) => row.source === term.source);
  if (found === undefined) throw new TermError("TERM_UNKNOWN", `term ${term.source} did not land`);
  return found;
}

/**
 * A term, moved from one book into the glossary every future book will read.
 *
 * The version bump is the point. A glossary's version rides in the cache key
 * of plan 2, so a glossary that has grown is a different question: without the
 * bump, later books would reuse translations made under a glossary that no
 * longer exists and believe they were made under this one.
 */
export function promoteToGlossary(
  db: DatabaseSync, termId: string, glossaryId: string,
): { version: number } {
  const term = db.prepare("SELECT source, target, rule, sense, note, approval_state FROM term WHERE id = ?")
    .get(termId) as (Omit<Row, "id" | "origin" | "occurrences"> | undefined);
  if (term === undefined) throw new TermError("TERM_UNKNOWN", `no term ${termId}`);
  if (term.approval_state !== "approved") {
    throw new TermError("NOT_APPROVED", `term ${termId} is ${term.approval_state}`);
  }

  const glossary = db.prepare("SELECT version FROM glossary WHERE id = ?")
    .get(glossaryId) as { version: number } | undefined;
  if (glossary === undefined) throw new TermError("GLOSSARY_UNKNOWN", `no glossary ${glossaryId}`);

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO glossary_term (id, glossary_id, source, target, rule, sense, note)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (glossary_id, source) DO UPDATE SET
        target = excluded.target, rule = excluded.rule,
        sense = excluded.sense, note = excluded.note
    `).run(randomUUID(), glossaryId, term.source, term.target, term.rule, term.sense, term.note);

    // Bumped even when the entry was only updated: a changed rendering is as
    // much a new question as a new entry, and the cache must not answer it
    // with what the old one said.
    db.prepare("UPDATE glossary SET version = version + 1 WHERE id = ?").run(glossaryId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { version: glossary.version + 1 };
}
