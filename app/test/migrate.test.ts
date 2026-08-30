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

    expect(migrate(db, migrations).applied).toEqual(["013-machinery-not-a-unit"]);

    const rows = db.prepare("SELECT id FROM unit ORDER BY ordinal").all() as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(["u2", "u3", "u4", "u5"]);
  });
});
