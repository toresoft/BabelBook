import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";

function migrated() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  return db;
}

describe("schema", () => {
  it("has every table the design names", () => {
    const names = (migrated().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((t) => t.name);
    for (const t of [
      "project", "project_document", "unit", "translation", "term",
      "glossary", "glossary_term", "project_glossary",
      "provider", "provider_model", "run", "run_event", "setting",
    ]) expect(names).toContain(t);
  });

  it("refuses a unit whose project does not exist", () => {
    const db = migrated();
    expect(() => db.prepare(
      "INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, range_start, range_end, state, source_text) "
      + "VALUES ('u1', 'ghost', 'd1', 1, 'c1#1', 0, 1, 'translate', 'x')",
    ).run()).toThrow();
  });

  it("keeps one translation per unit and cache key", () => {
    const db = migrated();
    db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
      + "VALUES ('p1','b.epub','Book','/w','h','2026-08-24','it','ready')").run();
    db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
    db.prepare("INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, range_start, range_end, state, source_text) "
      + "VALUES ('u1','p1','d1',1,'c1.xhtml#1',0,5,'translate','One')").run();
    const ins = "INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome) VALUES (?,?,?,?,?,?)";
    db.prepare(ins).run("t1", "u1", "Uno", "k1", 1, "translated");
    expect(() => db.prepare(ins).run("t2", "u1", "Uno bis", "k1", 1, "translated")).toThrow();
    db.prepare(ins).run("t3", "u1", "Uno ter", "k2", 1, "translated");
  });

  it("deletes a project's rows with the project", () => {
    const db = migrated();
    db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
      + "VALUES ('p1','b.epub','Book','/w','h','2026-08-24','it','ready')").run();
    db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
    db.prepare("DELETE FROM project WHERE id = 'p1'").run();
    expect((db.prepare("SELECT count(*) AS n FROM project_document").get() as { n: number }).n).toBe(0);
  });
});
