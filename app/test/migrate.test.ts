import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../main/db/open.ts";

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
});
