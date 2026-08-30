import type { DatabaseSync } from "node:sqlite";
import { createActor, type Actor } from "xstate";
import {
  INITIAL_CONTEXT,
  projectMachine,
  type ProjectContext,
  type ProjectEvent,
  type ProjectState,
} from "../../../core/workflow/project.machine.ts";
import { enterState, leaveState } from "./states.ts";

interface ProjectRow {
  state: ProjectState;
  machine_snapshot: string | null;
  source_language: string | null;
}

export interface MachineHost {
  readonly state: ProjectState;
  readonly snapshot: unknown;
  /** The events a user could send right now, asked of the machine itself. */
  readonly allows: UserEvent[];
  /** Returns false without writing when the machine refuses the event. */
  send(event: ProjectEvent): boolean;
}

/**
 * The events a person can cause, as opposed to the ones work causes.
 *
 * TERMS_READY, CODE_INDEXED, TRANSLATED, COMPOSED and FAIL are reports of
 * something that happened; offering them as buttons would let the window
 * claim a phase finished that never ran.
 */
export const USER_EVENTS = [
  "LANGUAGE_SET", "START", "PAUSE", "RESUME", "TERMS_APPROVED", "CODE_REVIEWED",
  // COMPOSE is a person's: it re-runs the composition over translations that
  // already exist, and only an ending accepts it.
  "COMPOSE",
] as const;

export type UserEvent = (typeof USER_EVENTS)[number];

type ProjectActor = Actor<typeof projectMachine>;

function stateValue(actor: ProjectActor): ProjectState {
  return actor.getSnapshot().value as ProjectState;
}

function degradationCount(db: DatabaseSync, projectId: string): number {
  const row = db.prepare(`
    SELECT count(*) AS total
      FROM run_event e
      JOIN run r ON r.id = e.run_id
     WHERE r.project_id = ? AND e.severity = 'degradation'
  `).get(projectId) as { total: number };
  return row.total;
}

function persist(
  db: DatabaseSync,
  projectId: string,
  actor: ProjectActor,
  previousState: ProjectState,
): void {
  const snapshot = actor.getPersistedSnapshot();
  const state = stateValue(actor);

  // A savepoint is a transaction when called alone and composes safely with a
  // future outer lifecycle transaction. Either both representations move, or
  // neither does.
  db.exec("SAVEPOINT babelbook_machine_transition");
  try {
    const changed = db.prepare(`
      UPDATE project SET machine_snapshot = ?, state = ? WHERE id = ?
    `).run(JSON.stringify(snapshot), state, projectId);
    if (changed.changes !== 1) throw new Error(`no such project: ${projectId}`);
    if (state !== previousState) {
      enterState(db, { projectId, kind: "project", name: state });
    }
    db.exec("RELEASE SAVEPOINT babelbook_machine_transition");
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT babelbook_machine_transition");
    db.exec("RELEASE SAVEPOINT babelbook_machine_transition");
    throw error;
  }
}

function actorAt(row: ProjectRow, input: Partial<ProjectContext>): ProjectActor {
  let storedContext: Partial<ProjectContext> = {};
  let storedState = row.state;
  if (row.machine_snapshot !== null) {
    const parsed = JSON.parse(row.machine_snapshot) as {
      value?: ProjectState;
      context?: Partial<ProjectContext>;
    };
    storedState = parsed.value ?? storedState;
    storedContext = parsed.context ?? {};
  }

  const context: ProjectContext = {
    ...INITIAL_CONTEXT,
    hasLanguage: row.source_language !== null,
    ...storedContext,
    ...input,
  };
  const snapshot = projectMachine.resolveState({ value: storedState, context });
  return createActor(projectMachine, { snapshot }).start();
}

/**
 * Hosts the pure project machine beside SQLite in the main process.
 *
 * The engine receives neither this object nor the database. Task 8 can feed
 * accepted engine checkpoints into `send` while phase work continues to use
 * the ProjectStore proxy from Task 5.
 */
export function makeMachineHost(
  db: DatabaseSync,
  projectId: string,
  input: Partial<ProjectContext> = {},
): MachineHost {
  const row = db.prepare(`
    SELECT state, machine_snapshot, source_language FROM project WHERE id = ?
  `).get(projectId) as ProjectRow | undefined;
  if (row === undefined) throw new Error(`no such project: ${projectId}`);

  let actor = actorAt(row, input);

  return {
    get state(): ProjectState {
      return stateValue(actor);
    },

    get snapshot(): unknown {
      return actor.getPersistedSnapshot();
    },

    // Asked of the machine rather than re-derived from the state name. A
    // condition rewritten in a template diverges from the machine the day the
    // machine changes, and nothing fails until a user presses the button.
    get allows(): UserEvent[] {
      const snapshot = actor.getSnapshot();
      return USER_EVENTS.filter((type) => snapshot.can({ type } as ProjectEvent));
    },

    send(event): boolean {
      if (!actor.getSnapshot().can(event)) return false;
      const previousState = stateValue(actor);

      if (event.type === "COMPOSED") {
        const context = {
          ...actor.getSnapshot().context,
          degradations: degradationCount(db, projectId),
        };
        actor.stop();
        actor = createActor(projectMachine, {
          snapshot: projectMachine.resolveState({ value: stateValue(actor), context }),
        }).start();
      }

      actor.send(event);
      persist(db, projectId, actor, previousState);
      return true;
    },
  };
}

/**
 * Crash recovery is deliberately inert: work that was active becomes paused,
 * and no START/RESUME event is ever sent during application startup.
 */
export function restoreRunningProjects(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT id FROM project ORDER BY id",
  ).all() as Array<{ id: string }>;

  const paused: string[] = [];
  for (const row of rows) {
    const host = makeMachineHost(db, row.id);
    if (host.state !== "running") continue;

    db.exec("SAVEPOINT babelbook_restore_running");
    try {
      if (host.send({ type: "PAUSE" })) {
        leaveState(db, { projectId: row.id, kind: "phase", outcome: "paused" });
        paused.push(row.id);
      }
      db.exec("RELEASE SAVEPOINT babelbook_restore_running");
    } catch (error) {
      db.exec("ROLLBACK TO SAVEPOINT babelbook_restore_running");
      db.exec("RELEASE SAVEPOINT babelbook_restore_running");
      throw error;
    }
  }
  return paused;
}
