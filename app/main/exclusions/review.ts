import type { DatabaseSync } from "node:sqlite";
import type { ExcludedState, ExclusionGroup } from "../../shared/dto.ts";
import { displayText } from "../units/display.ts";
import { BabelError } from "../../../core/errors.ts";

export type { ExcludedState, ExclusionGroup } from "../../shared/dto.ts";

/** Thrown with a code, never with a sentence: the interface owns the words. */
export class ExclusionError extends BabelError {
  constructor(code: string, message: string) {
    // `config`: every one of these refuses because of a state somebody can
    // change. Pressing the same button again is never the answer.
    super(`${code}: ${message}`, { code, fault: "config" });
    this.name = "ExclusionError";
  }
}

interface Row {
  unit_id: string;
  ordinal: number;
  source_text: string;
  raw_text: string | null;
  effective: ExclusionGroup["state"];
  reason: string | null;
  forced_state: string | null;
  zip_path: string;
}

/**
 * Everything that will not be translated, and everything the user has touched.
 *
 * Grouped by state and reason because that is how it is read: "forty blocks
 * excluded by the stylesheet" is one question, not forty of them.
 *
 * A unit the user has freed stays on the list, marked as theirs. Dropping it
 * the moment it stops being an exclusion would make the screen a trap — the
 * change would vanish along with the only place to undo it from.
 */
export function listExclusions(db: DatabaseSync, projectId: string): ExclusionGroup[] {
  const rows = db.prepare(`
    SELECT u.unit_id, u.ordinal, u.source_text, u.raw_text, u.reason, u.forced_state,
           coalesce(u.forced_state, u.state) AS effective,
           d.zip_path
      FROM unit u
      JOIN project_document d ON d.id = u.document_id
     WHERE u.project_id = ?
       AND (coalesce(u.forced_state, u.state) <> 'translate' OR u.forced_state IS NOT NULL)
     ORDER BY d.spine_order, u.ordinal
  `).all(projectId) as unknown as Row[];

  const groups = new Map<string, ExclusionGroup>();
  for (const row of rows) {
    const key = `${row.effective} ${row.reason ?? ""} ${row.zip_path}`;
    const group = groups.get(key)
      ?? { state: row.effective, reason: row.reason, doc: row.zip_path, units: [] };
    group.units.push({
      unitId: row.unit_id,
      ordinal: Number(row.ordinal),
      text: displayText(row.raw_text, row.source_text),
      forced: row.forced_state !== null,
    });
    groups.set(key, group);
  }

  return [...groups.values()];
}

/**
 * The user's verdict on a unit, written beside what we deduced rather than over it.
 *
 * `state` is never touched. Keeping the deduced state is what makes the
 * decision reversible and what keeps "the program worked this out" apart from
 * "the user said so" — a distinction the report needs and an overwrite would
 * destroy. The planner reads `coalesce(forced_state, state)`, so the forced
 * value is the one that acts.
 *
 * All of them or none: this is one decision about a screenful of units.
 */
export function forceState(
  db: DatabaseSync,
  projectId: string,
  changes: Array<{ unitId: string; state: "translate" | "code" }>,
): { toTranslate: number; toCode: number } {
  const counts = { toTranslate: 0, toCode: 0 };

  db.exec("BEGIN");
  try {
    for (const change of changes) {
      const applied = db.prepare(
        "UPDATE unit SET forced_state = ?, forced_by = 'user' WHERE project_id = ? AND unit_id = ?",
      ).run(change.state, projectId, change.unitId).changes;
      if (Number(applied) === 0) {
        throw new ExclusionError("UNIT_UNKNOWN", `no unit ${change.unitId} in project ${projectId}`);
      }
      if (change.state === "translate") counts.toTranslate++;
      else counts.toCode++;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return counts;
}

/** Undoes the user's verdict, leaving what was deduced to stand on its own. */
export function clearForced(
  db: DatabaseSync, projectId: string, unitIds: string[],
): { cleared: number } {
  if (unitIds.length === 0) return { cleared: 0 };

  const placeholders = unitIds.map(() => "?").join(",");
  const cleared = db.prepare(`
    UPDATE unit SET forced_state = NULL, forced_by = NULL
     WHERE project_id = ? AND forced_state IS NOT NULL AND unit_id IN (${placeholders})
  `).run(projectId, ...unitIds).changes;

  return { cleared: Number(cleared) };
}
