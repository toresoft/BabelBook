import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { runLog } from "../main/run/log.ts";
import { enterState, leaveState } from "../main/run/states.ts";

function seeded(): DatabaseSync {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state, layout)
    VALUES ('p1','b.epub','Book','/w','sha','2026-08-30T09:00:00.000Z','it','ready','reflowable')
  `).run();
  db.prepare(`
    INSERT INTO run (id, project_id, phase, started_at, ended_at)
    VALUES ('r0', 'p1', 'translate', '2026-08-30T08:00:00.000Z', '2026-08-30T08:30:00.000Z'),
           ('r1', 'p1', 'translate', '2026-08-30T09:00:00.000Z', NULL)
  `).run();
  return db;
}

function event(
  db: DatabaseSync, id: string, at: string,
  options: { runId?: string; code?: string; severity?: string } = {},
): void {
  db.prepare(`
    INSERT INTO run_event (id, run_id, at, code, severity)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, options.runId ?? "r1", at, options.code ?? "chunk-exhausted", options.severity ?? "degradation");
}

function phaseDone(db: DatabaseSync, name: string, from: string, to: string): void {
  enterState(db, { projectId: "p1", runId: "r1", kind: "phase", name, enteredAt: from });
  leaveState(db, { projectId: "p1", kind: "phase", outcome: "done", leftAt: to });
}

describe("runLog", () => {
  it("weaves the states and the events into one history", () => {
    const db = seeded();
    phaseDone(db, "analyze", "2026-08-30T09:00:10.000Z", "2026-08-30T09:02:00.000Z");
    event(db, "e1", "2026-08-30T09:03:00.000Z");
    phaseDone(db, "candidates", "2026-08-30T09:04:00.000Z", "2026-08-30T09:06:00.000Z");

    expect(runLog(db, "p1").map((line) => line.code))
      .toEqual(["phase.analyze.done", "chunk-exhausted", "phase.candidates.done"]);
  });

  it("holds a long run to the last two hundred, keeping the end", () => {
    const db = seeded();
    for (let i = 0; i < 250; i += 1) {
      const minute = String(Math.floor(i / 60)).padStart(2, "0");
      const second = String(i % 60).padStart(2, "0");
      event(db, `e${i}`, `2026-08-30T10:${minute}:${second}.000Z`, { code: `event-${i}`, severity: "info" });
    }

    const log = runLog(db, "p1");
    expect(log).toHaveLength(200);
    expect(log.at(-1)!.code).toBe("event-249");
  });

  it("calls a degradation a warning and a failure an error", () => {
    const db = seeded();
    event(db, "e1", "2026-08-30T09:00:30.000Z");
    enterState(db, {
      projectId: "p1", runId: "r1", kind: "phase", name: "translate",
      enteredAt: "2026-08-30T09:00:00.000Z",
    });
    leaveState(db, {
      projectId: "p1", kind: "phase", outcome: "failed",
      leftAt: "2026-08-30T09:01:00.000Z", info: { code: "provider-529" },
    });

    const log = runLog(db, "p1");
    expect(log.find((line) => line.code === "chunk-exhausted")!.severity).toBe("warning");
    expect(log.find((line) => line.code === "phase.translate.failed")!.severity).toBe("error");
  });

  it("tells the project's own story at the moment each state was entered", () => {
    const db = seeded();
    for (const [name, at] of [
      ["ready", "2026-08-30T09:00:00.000Z"],
      ["running", "2026-08-30T09:01:00.000Z"],
      ["done", "2026-08-30T09:59:00.000Z"],
    ] as const) {
      enterState(db, { projectId: "p1", kind: "project", name, enteredAt: at });
    }

    // `done` is never left by another state: its moment is its entering, or
    // the log would end one line short of the only ending that matters.
    expect(runLog(db, "p1").map((line) => line.code))
      .toEqual(["state.ready", "state.running", "state.done"]);
  });

  it("keeps to the last run's events: an older run's troubles were that run's", () => {
    const db = seeded();
    event(db, "old", "2026-08-30T08:10:00.000Z", { runId: "r0", code: "old-trouble" });
    event(db, "new", "2026-08-30T09:10:00.000Z", { code: "chunk-exhausted" });

    expect(runLog(db, "p1").map((line) => line.code)).toEqual(["chunk-exhausted"]);
  });

  it("carries how long a finished phase took, beside what it learned", () => {
    const db = seeded();
    phaseDone(db, "analyze", "2026-08-30T09:00:00.000Z", "2026-08-30T09:01:05.000Z");

    expect(runLog(db, "p1")[0]!.info).toEqual({ durationSeconds: 65 });
  });
});
