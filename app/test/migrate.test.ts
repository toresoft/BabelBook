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

    expect(migrate(db, migrations).applied).toEqual(["011-model-reasoning"]);

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
});
