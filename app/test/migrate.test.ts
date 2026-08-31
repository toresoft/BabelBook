import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";

const m = (id: string, sql: string) => ({ id, sql });

describe("migrate", () => {
  it("applies migrations in id order and records them", () => {
    const db = openDatabase(":memory:");
    const applied = migrate(db, [
      m("002-second", "CREATE TABLE b (id TEXT);"),
      m("001-first", "CREATE TABLE a (id TEXT);"),
    ]);
    expect(applied.applied).toEqual(["001-first", "002-second"]);
  });

  it("is idempotent: running twice applies nothing new", () => {
    const db = openDatabase(":memory:");
    const ms = [m("001-first", "CREATE TABLE a (id TEXT);")];
    migrate(db, ms);
    expect(migrate(db, ms).applied).toEqual([]);
  });

  it("leaves the database untouched when a migration fails", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db, [
      m("001-first", "CREATE TABLE a (id TEXT);"),
      m("002-bad", "CREATE TABLE ;;;"),
    ])).toThrow();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("a");
  });

  it("turns on WAL and foreign keys", () => {
    const db = openDatabase(":memory:");
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });

  it("removes the historical DeepSeek reasoning default without losing its other options", () => {
    const db = openDatabase(":memory:");
    const migrations = loadMigrations("app/main/db/migrations");
    migrate(db, migrations.filter((migration) => migration.id < "011-model-reasoning"));
    db.prepare(`
      INSERT INTO provider (id, name, route, options)
      VALUES ('p1', 'DeepSeek', 'deepseek', ?),
             ('p2', 'DeepSeek bare', 'deepseek', ?),
             ('p3', 'DeepSeek manual', 'deepseek', ?)
    `).run(
      JSON.stringify({
        audit: { trace: true },
        deepseek: { temperature: 0.2, thinking: { type: "disabled" } },
      }),
      JSON.stringify({ deepseek: { thinking: { type: "disabled" } } }),
      JSON.stringify({ deepseek: { temperature: 0.4, thinking: "manual" } }),
    );

    expect(migrate(db, migrations).applied)
      .toEqual([
        "011-model-reasoning", "012-model-reasoning-level", "013-machinery-not-a-unit",
        "014-project-state", "015-project-auto-accept",
      ]);

    const rows = db.prepare("SELECT id, options FROM provider ORDER BY id").all() as
      Array<{ id: string; options: string }>;
    expect(rows.map((row) => ({ id: row.id, options: JSON.parse(row.options) as unknown })))
      .toEqual([
        {
          id: "p1",
          options: { audit: { trace: true }, deepseek: { temperature: 0.2 } },
        },
        { id: "p2", options: {} },
        {
          id: "p3",
          options: { deepseek: { temperature: 0.4, thinking: "manual" } },
        },
      ]);
  });

  it("drops the style and script units of books analysed before they stopped being units", () => {
    const db = openDatabase(":memory:");
    const migrations = loadMigrations("app/main/db/migrations");
    migrate(db, migrations.filter((migration) => migration.id < "013-machinery-not-a-unit"));

    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           target_language, state, layout)
      VALUES ('p1', 'b.epub', 'Book', '/w', 'sha', '2026-01-01T00:00:00Z', 'it', 'ready', 'reflowable')
    `).run();
    db.prepare(
      "INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',0)",
    ).run();

    const unit = db.prepare(`
      INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, kind,
                        range_start, range_end, state, source_text, forced_state, owner_unit_id)
      VALUES (?,'p1','d1',?,?,?,0,1,?,?,?,?)
    `);
    unit.run("u1", 1, "c1.xhtml#1", "block", "never-translated", "body { margin: 0 }", null, null);
    unit.run("u2", 2, "c1.xhtml#2", "block", "never-translated", "var a = 1;", "translate", null);
    unit.run("u3", 3, "c1.xhtml#3", "block", "never-translated", "<0/>", null, null);
    unit.run("u4", 4, "c1.xhtml#4", "attribute", "translate", "A cat", null, "c1.xhtml#3");
    unit.run("u5", 5, "c1.xhtml#5", "block", "translate", "One", null, null);

    expect(migrate(db, migrations).applied)
      .toEqual(["013-machinery-not-a-unit", "014-project-state", "015-project-auto-accept"]);

    const rows = db.prepare("SELECT id FROM unit ORDER BY ordinal").all() as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(["u2", "u3", "u4", "u5"]);
  });

  it("gives an existing project one honest starting point for its history", () => {
    const db = openDatabase(":memory:");
    const migrations = loadMigrations("app/main/db/migrations");
    migrate(db, migrations.filter((migration) => migration.id < "014-project-state"));
    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           target_language, state, layout)
      VALUES ('p1', 'b.epub', 'Book', '/w', 'sha', '2026-01-02T03:04:05.000Z',
              'it', 'paused', 'reflowable')
    `).run();

    expect(migrate(db, migrations).applied)
      .toEqual(["014-project-state", "015-project-auto-accept"]);
    expect(db.prepare(`
      SELECT project_id, kind, name, entered_at, left_at
        FROM project_state WHERE project_id = 'p1'
    `).all()).toEqual([{
      project_id: "p1", kind: "project", name: "paused",
      entered_at: "2026-01-02T03:04:05.000Z", left_at: null,
    }]);
  });

  it("brings the two auto-acceptances down onto the projects that already exist", () => {
    const db = openDatabase(":memory:");
    const migrations = loadMigrations("app/main/db/migrations");
    migrate(db, migrations.filter((migration) => migration.id < "015-project-auto-accept"));

    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           target_language, state)
      VALUES ('p1', 'a.epub', 'A', '/w/p1', 'sha', '2026-08-31T00:00:00.000Z', 'it', 'ready'),
             ('p2', 'b.epub', 'B', '/w/p2', 'sha', '2026-08-31T00:00:00.000Z', 'it', 'ready')
    `).run();
    db.prepare("INSERT INTO setting (key, value) VALUES ('autoAcceptTerms', 'true')").run();

    expect(migrate(db, migrations).applied).toEqual(["015-project-auto-accept"]);

    // The row said true, so both books keep walking past the terms gate. The
    // exclusions row was absent, and absent is how readSettings spelled false:
    // a book that stopped there yesterday stops there today.
    expect(db.prepare(`
      SELECT auto_accept_terms AS terms, auto_accept_exclusions AS exclusions
        FROM project ORDER BY id
    `).all()).toEqual([{ terms: 1, exclusions: 0 }, { terms: 1, exclusions: 0 }]);

    // And the global setting is gone: two places to read one fact is one too many.
    expect(db.prepare("SELECT count(*) AS n FROM setting WHERE key LIKE 'autoAccept%'").get())
      .toEqual({ n: 0 });
  });

  it("opens both gates on a project created after the migration", () => {
    const db = openDatabase(":memory:");
    migrate(db, loadMigrations("app/main/db/migrations"));

    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           target_language, state)
      VALUES ('p1', 'a.epub', 'A', '/w/p1', 'sha', '2026-08-31T00:00:00.000Z', 'it', 'ready')
    `).run();

    expect(db.prepare(`
      SELECT auto_accept_terms AS terms, auto_accept_exclusions AS exclusions FROM project
    `).get()).toEqual({ terms: 1, exclusions: 1 });
  });
});
