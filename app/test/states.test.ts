import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { enterState, leaveState, statesOf } from "../main/run/states.ts";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state, layout)
    VALUES ('p1','b.epub','Book','/w','sha','2026-08-30T09:00:00.000Z','it','ready','reflowable')
  `).run();
  return db;
}

describe("the states of a project", () => {
  it("remembers what it entered, and when", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "phase", name: "analyze", info: { units: 9701 } });

    const [entry] = statesOf(db, "p1").filter((s) => s.kind === "phase");
    expect(entry).toMatchObject({ name: "analyze", outcome: null, leftAt: null });
    expect(entry!.info).toEqual({ units: 9701 });
    expect(Date.parse(entry!.enteredAt)).not.toBeNaN();
  });

  it("closes what it leaves, and says how it ended", () => {
    const db = seeded();
    enterState(db, {
      projectId: "p1", kind: "phase", name: "analyze", info: { units: 9701 },
    });
    leaveState(db, { projectId: "p1", kind: "phase", outcome: "done", info: { seconds: 108 } });

    const [entry] = statesOf(db, "p1").filter((s) => s.kind === "phase");
    expect(entry).toMatchObject({ outcome: "done" });
    expect(entry!.leftAt).not.toBeNull();
    // What it learned on the way out joins what it knew on the way in.
    expect(entry!.info).toEqual({ units: 9701, seconds: 108 });
  });

  /*
   * Two phases open at once would make "which phase is the book in?" a
   * question with two answers, and the timeline would draw both as running.
   */
  it("closes the one before when a new one of the same kind is entered", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "phase", name: "analyze" });
    enterState(db, { projectId: "p1", kind: "phase", name: "candidates" });

    const phases = statesOf(db, "p1").filter((s) => s.kind === "phase");
    expect(phases.map((p) => [p.name, p.leftAt === null]))
      .toEqual([["analyze", false], ["candidates", true]]);
  });

  it("keeps the project's own states apart from its phases", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "phase", name: "translate" });
    enterState(db, { projectId: "p1", kind: "project", name: "running" });

    // Entering a project state must not close a phase, and the other way round.
    expect(statesOf(db, "p1").filter((s) => s.leftAt === null)).toHaveLength(2);
  });

  it("keeps the current state open when the next one cannot be inserted", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "phase", name: "analyze" });

    expect(() => enterState(db, {
      projectId: "p1", runId: "missing-run", kind: "phase", name: "candidates",
    })).toThrow();

    expect(statesOf(db, "p1").filter((state) => state.kind === "phase"))
      .toMatchObject([{ name: "analyze", leftAt: null }]);
  });

  it("refuses two open states of the same kind even outside the helper", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "phase", name: "analyze" });

    expect(() => db.prepare(`
      INSERT INTO project_state (id, project_id, kind, name, entered_at)
      VALUES ('second-open', 'p1', 'phase', 'candidates', '2026-08-30T10:00:00.000Z')
    `).run()).toThrow();
  });

  it("gives them back oldest first: a history is read forwards", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "project", name: "running" });
    enterState(db, { projectId: "p1", kind: "project", name: "waiting-terms" });

    expect(statesOf(db, "p1").map((s) => s.name)).toEqual(["running", "waiting-terms"]);
  });
});
