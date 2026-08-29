import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { projectDetail } from "../main/projects/detail.ts";
import { listUnits } from "../main/units/list.ts";

function seeded(state = "ready") {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO project (id, filename, title, author, workspace_path, source_sha256, created_at,
                         description, source_language, target_language, state, layout,
                         has_overlays, cache_key)
    VALUES ('p1','a.epub','A Book','An Author','/w','h','2026-08-24',
            'Second volume','en','it',?,'reflowable',1,'k1')
  `).run(state);
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
  db.prepare(`
    INSERT INTO run (id, project_id, phase, started_at, tokens_in, tokens_out)
    VALUES ('r1','p1','translate','2026-08-24',700,300)
  `).run();

  const unit = db.prepare(`
    INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                      range_start, range_end, state, reason, source_text, raw_text)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  const rows: Array<[string, string, string, string | null]> = [
    ["u1", "The road to Rivendell", "translate", null],
    ["u2", "gem install foo", "code", "css-code-surface"],
    ["u3", "A quiet evening", "translate", null],
  ];
  rows.forEach(([id, text, unitState, reason], at) => {
    unit.run(id, "p1", "d1", at + 1, `c1.xhtml#${at + 1}`, at, at + 1, unitState, reason, text, text);
  });
  db.prepare(`
    INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome)
    VALUES ('t1','u1','La strada per Gran Burrone','k1',1,'translated')
  `).run();
  return db;
}

describe("projectDetail", () => {
  it("carries what the header shows, the description included", () => {
    expect(projectDetail(seeded(), "p1")).toMatchObject({
      id: "p1",
      title: "A Book",
      author: "An Author",
      description: "Second volume",
      sourceLanguage: "en",
      targetLanguage: "it",
      hasOverlays: true,
    });
  });

  it("asks the machine which buttons are available, and does not guess", () => {
    const ready = projectDetail(seeded("ready"), "p1");
    expect(ready).not.toBeNull();
    expect(ready!.actions).toContain("START");

    const paused = projectDetail(seeded("paused"), "p1");
    expect(paused!.actions).toContain("RESUME");
    expect(paused!.actions).not.toContain("PAUSE");
  });

  it("reports what the run has spent so far", () => {
    expect(projectDetail(seeded(), "p1")).toMatchObject({ tokens: { in: 700, out: 300 } });
  });

  it("sums what the runs cost, when every one of them could be priced", () => {
    const db = seeded();
    db.prepare("UPDATE run SET cost = 0.07 WHERE id = 'r1'").run();
    db.prepare(`
      INSERT INTO run (id, project_id, phase, started_at, tokens_in, tokens_out, cost)
      VALUES ('r2','p1','translate','2026-08-25',100,100,0.15)
    `).run();
    expect(projectDetail(db, "p1")).toMatchObject({ cost: 0.22 });
  });

  it("keeps the cost unsaid when a run had no prices, rather than guessing low", () => {
    const db = seeded();
    db.prepare("UPDATE run SET cost = 0.07 WHERE id = 'r1'").run();
    db.prepare(`
      INSERT INTO run (id, project_id, phase, started_at, tokens_in, tokens_out)
      VALUES ('r2','p1','translate','2026-08-25',100,100)
    `).run();
    // A sum that quietly skipped the unpriced run would name a number the
    // true total is only the floor of.
    expect(projectDetail(db, "p1")).toMatchObject({ cost: null });
    expect(projectDetail(seeded(), "p1")).toMatchObject({ cost: null });
  });

  it("counts progress against the units that are actually work", () => {
    // Two translatable units, one translated; the code block is not work.
    expect(projectDetail(seeded(), "p1")).toMatchObject({ progress: { done: 1, total: 2 } });
  });

  it("leaves a fallback out of the progress, because the unit is still untranslated", () => {
    const db = seeded();
    db.prepare(`
      INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome)
      VALUES ('tf','u3','A quiet evening','k1',3,'fell-back')
    `).run();

    expect(projectDetail(db, "p1")).toMatchObject({ progress: { done: 1, total: 2 } });
  });

  it("answers null for a project that is not there", () => {
    expect(projectDetail(seeded(), "ghost")).toBeNull();
  });
});

describe("listUnits", () => {
  it("puts the source beside its translation", () => {
    const found = listUnits(seeded(), "p1", {});

    expect(found.total).toBe(3);
    expect(found.units.find((row) => row.unitId === "c1.xhtml#1")).toMatchObject({
      source: "The road to Rivendell",
      translation: "La strada per Gran Burrone",
      outcome: "translated",
      state: "translate",
    });
  });

  it("says a unit has no translation rather than pretending it has an empty one", () => {
    const found = listUnits(seeded(), "p1", {});

    expect(found.units.find((row) => row.unitId === "c1.xhtml#3")).toMatchObject({
      translation: null, outcome: null,
    });
  });

  it("filters by the state that actually applies", () => {
    const db = seeded();
    db.prepare("UPDATE unit SET forced_state = 'translate', forced_by = 'user' WHERE id = 'u2'").run();

    // The forced state is the one that acts, so it is the one the filter must
    // read: otherwise a block the user freed is invisible under `translate`.
    const freed = listUnits(db, "p1", { state: "translate" });
    expect(freed.units.map((row) => row.unitId)).toContain("c1.xhtml#2");
    expect(listUnits(db, "p1", { state: "code" }).units).toEqual([]);
  });

  it("searches the source and the translation both", () => {
    expect(listUnits(seeded(), "p1", { search: "Rivendell" }).units.map((row) => row.unitId))
      .toEqual(["c1.xhtml#1"]);
    expect(listUnits(seeded(), "p1", { search: "Gran Burrone" }).units.map((row) => row.unitId))
      .toEqual(["c1.xhtml#1"]);
  });

  it("pages without losing the total, so the count means the whole book", () => {
    const page = listUnits(seeded(), "p1", { limit: 2, offset: 0 });

    expect(page.units).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(listUnits(seeded(), "p1", { limit: 2, offset: 2 }).units).toHaveLength(1);
  });

  it("says who forced a state, so the screen can mark it", () => {
    const db = seeded();
    db.prepare("UPDATE unit SET forced_state = 'code', forced_by = 'user' WHERE id = 'u3'").run();

    expect(listUnits(db, "p1", {}).units.find((row) => row.unitId === "c1.xhtml#3"))
      .toMatchObject({ state: "code", forced: true });
  });

  it("keeps the book's order, because a reader reads it in that order", () => {
    expect(listUnits(seeded(), "p1", {}).units.map((row) => row.ordinal)).toEqual([1, 2, 3]);
  });
});
