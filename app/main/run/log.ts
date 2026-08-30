import type { DatabaseSync } from "node:sqlite";
import type { LogLine } from "../../shared/dto.ts";
import { statesOf, type StateRecord } from "./states.ts";

/** What the log calls an event the engine recorded with the given severity. */
const SEVERITIES: Record<string, LogLine["severity"]> = {
  degradation: "warning",
  error: "error",
};

interface EventRow {
  at: string;
  code: string;
  severity: string;
  payload_json: string | null;
}

/**
 * The story of the last run, told in one sequence.
 *
 * Two sources, one order: the states the project lived through — a phase
 * finished, a pause, the book itself entering a new state — beside the events
 * its engine reported, each at its own moment. The states are the whole
 * history; the events are the last run's only, because a retranslation's
 * degradations are that run's troubles, not the book's.
 */
export function runLog(db: DatabaseSync, projectId: string, limit = 200): LogLine[] {
  const lines: LogLine[] = [];

  for (const entry of statesOf(db, projectId)) {
    if (entry.kind === "phase") {
      // A phase's news is how it ended, so its moment is the one it left at.
      // A phase still open is no news yet: the timeline tells that live.
      if (entry.leftAt === null) continue;
      lines.push({
        at: entry.leftAt,
        kind: "state",
        code: `phase.${entry.name}.${entry.outcome ?? "left"}`,
        severity: severityOf(entry.outcome),
        info: withDuration(entry),
      });
    } else {
      // A project state's news is the entering of it — `done` in particular
      // is never left, and its moment is the moment the book was finished.
      lines.push({
        at: entry.enteredAt,
        kind: "state",
        code: `state.${entry.name}`,
        severity: entry.name === "failed" ? "error" : "info",
        info: entry.info,
      });
    }
  }

  const events = db.prepare(`
    SELECT e.at, e.code, e.severity, e.payload_json
      FROM run_event e
      JOIN run r ON r.id = e.run_id
     WHERE r.project_id = ?
       AND r.started_at = (SELECT max(started_at) FROM run WHERE project_id = ?)
  `).all(projectId, projectId) as unknown as EventRow[];

  for (const event of events) {
    lines.push({
      at: event.at,
      kind: "event",
      code: event.code,
      severity: SEVERITIES[event.severity] ?? "info",
      info: parse(event.payload_json),
    });
  }

  lines.sort((one, other) => one.at.localeCompare(other.at));
  return lines.slice(-limit);
}

function severityOf(outcome: StateRecord["outcome"]): LogLine["severity"] {
  if (outcome === "failed") return "error";
  if (outcome === "paused") return "warning";
  return "info";
}

/** What a finished phase knows about itself, with how long it took added. */
function withDuration(entry: StateRecord): Record<string, unknown> | null {
  if (entry.outcome !== "done" || entry.leftAt === null) return entry.info;
  const seconds = Math.max(0, Math.round((Date.parse(entry.leftAt) - Date.parse(entry.enteredAt)) / 1000));
  return { ...entry.info, durationSeconds: seconds };
}

function parse(payload: string | null): Record<string, unknown> | null {
  if (payload === null) return null;
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}
