import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** One state a project entered, with the dates and the facts that are its own. */
export interface StateRecord {
  kind: "project" | "phase";
  name: string;
  outcome: "done" | "failed" | "paused" | "cancelled" | null;
  enteredAt: string;
  leftAt: string | null;
  info: Record<string, unknown> | null;
}

interface Row {
  kind: string;
  name: string;
  outcome: string | null;
  entered_at: string;
  left_at: string | null;
  info_json: string | null;
}

const now = (): string => new Date().toISOString();

/**
 * Enters a state, closing whatever of the same kind was open.
 *
 * Two open phases would make "which phase is this book in?" a question with
 * two answers, and a timeline that draws both as running. Closing here rather
 * than asking every caller to remember is what keeps that impossible.
 */
export function enterState(db: DatabaseSync, entry: {
  projectId: string;
  runId?: string | null;
  kind: StateRecord["kind"];
  name: string;
  /** A fact captured before the project row existed, such as analysis start. */
  enteredAt?: string;
  info?: Record<string, unknown>;
}): void {
  db.exec("SAVEPOINT babelbook_enter_state");
  try {
    db.prepare(`
      UPDATE project_state SET left_at = ?
       WHERE project_id = ? AND kind = ? AND left_at IS NULL
    `).run(now(), entry.projectId, entry.kind);

    db.prepare(`
      INSERT INTO project_state (id, project_id, run_id, kind, name, entered_at, info_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), entry.projectId, entry.runId ?? null, entry.kind, entry.name,
      entry.enteredAt ?? now(),
      entry.info === undefined ? null : JSON.stringify(entry.info),
    );
    db.exec("RELEASE SAVEPOINT babelbook_enter_state");
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT babelbook_enter_state");
    db.exec("RELEASE SAVEPOINT babelbook_enter_state");
    throw error;
  }
}

/** Closes the open state of a kind, saying how it ended and what it learned. */
export function leaveState(db: DatabaseSync, entry: {
  projectId: string;
  kind: StateRecord["kind"];
  outcome: NonNullable<StateRecord["outcome"]>;
  info?: Record<string, unknown>;
}): void {
  const current = db.prepare(`
    SELECT info_json FROM project_state
     WHERE project_id = ? AND kind = ? AND left_at IS NULL
     ORDER BY entered_at DESC, rowid DESC LIMIT 1
  `).get(entry.projectId, entry.kind) as { info_json: string | null } | undefined;
  const learned = entry.info === undefined
    ? null
    : JSON.stringify({ ...(parse(current?.info_json ?? null) ?? {}), ...entry.info });

  db.prepare(`
    UPDATE project_state
       SET left_at = ?, outcome = ?, info_json = coalesce(?, info_json)
     WHERE project_id = ? AND kind = ? AND left_at IS NULL
  `).run(
    now(), entry.outcome, learned, entry.projectId, entry.kind,
  );
}

/** The whole history, oldest first: a history is read forwards. */
export function statesOf(db: DatabaseSync, projectId: string): StateRecord[] {
  const rows = db.prepare(`
    SELECT kind, name, outcome, entered_at, left_at, info_json
      FROM project_state WHERE project_id = ?
     ORDER BY entered_at ASC, rowid ASC
  `).all(projectId) as unknown as Row[];

  return rows.map((row) => ({
    kind: row.kind as StateRecord["kind"],
    name: row.name,
    outcome: row.outcome as StateRecord["outcome"],
    enteredAt: row.entered_at,
    leftAt: row.left_at,
    // A payload that stopped being JSON is a fact we no longer have, not a
    // crash: the history is read on a screen, and one bad row must not empty it.
    info: parse(row.info_json),
  }));
}

function parse(payload: string | null): Record<string, unknown> | null {
  if (payload === null) return null;
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}
