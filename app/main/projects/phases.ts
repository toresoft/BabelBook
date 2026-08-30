import { RUN_PHASES, type PhaseProgress, type PhaseState } from "../../shared/dto.ts";
import type { StateRecord } from "../run/states.ts";

/** The project states in which a phase left open is a phase actually moving. */
const MOVING = new Set(["running", "composing", "waiting-terms", "waiting-code"]);

/**
 * The five phases, each read from the last state it recorded.
 *
 * The record says when a phase began, when it ended and how; the project's
 * state says whether a phase still open is moving or was abandoned there by a
 * pause, a failure or a window that closed. Neither answers alone.
 */
export function phasesOf(
  history: StateRecord[],
  projectState: string,
  units: { done: number; total: number },
): PhaseProgress[] {
  const last = new Map<string, StateRecord>();
  for (const entry of history) {
    if (entry.kind === "phase") last.set(entry.name, entry);
  }

  return RUN_PHASES.map((phase) => {
    const entry = last.get(phase);
    const counts = phase === "translate" ? units : { done: null, total: null };
    if (entry === undefined) {
      return {
        phase, state: "waiting" as PhaseState, startedAt: null, endedAt: null,
        done: counts.done, total: counts.total, info: null,
      };
    }
    return {
      phase,
      state: stateOf(entry, projectState),
      startedAt: entry.enteredAt,
      endedAt: entry.leftAt,
      done: counts.done,
      total: counts.total,
      info: entry.info,
    };
  });
}

function stateOf(entry: StateRecord, projectState: string): PhaseState {
  if (entry.outcome === "done") return "done";
  if (entry.outcome === "failed") return "failed";
  if (entry.outcome === "paused") return "paused";
  if (entry.leftAt !== null) return "waiting";
  if (projectState === "failed") return "failed";
  if (projectState === "paused") return "paused";
  return MOVING.has(projectState) ? "running" : "waiting";
}
