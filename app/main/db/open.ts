import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One hand-written schema step, named by the file it came from. */
export interface Migration {
  id: string;
  sql: string;
}

export interface MigrationResult {
  applied: string[];
}

/** The ledger of what has already run. Its own name is never a migration id. */
const LEDGER = "schema_migration";

/**
 * Opens the database with the pragmas the schema assumes.
 *
 * Foreign keys are off by default in SQLite: a schema that declares them
 * without turning them on does not enforce them, and the first orphan row
 * appears months later with nothing to blame. WAL lets a reader and the writer
 * work at once, which is what a window and a translation run are; in memory it
 * is silently ignored.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.prepare("PRAGMA journal_mode = WAL").get();
  db.exec("PRAGMA foreign_keys = ON");
  // Rather than failing outright when the other end of the WAL is mid-write.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** Ids start with a number, so their order is the order they must run in. */
function byId(a: Migration, b: Migration): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Reads the .sql files of a directory as migrations, named after the file.
 *
 * The order is the ids', never the filesystem's: readdir gives no ordering
 * guarantee, and a schema applied in the wrong order is a schema that fails on
 * one machine and not on another.
 */
export function loadMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ id: name.slice(0, -".sql".length), sql: readFileSync(join(dir, name), "utf8") }))
    .sort(byId);
}

function ensureLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
}

/** The id of the last migration applied, or null on a database with none. */
export function currentVersion(db: DatabaseSync): string | null {
  ensureLedger(db);
  const row = db.prepare(`SELECT id FROM ${LEDGER} ORDER BY id DESC LIMIT 1`).get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/**
 * Applies whatever has not been applied, in id order, in one transaction.
 *
 * All of them together, or none: half a schema is the worst state to be left
 * in, because the next start finds a database that looks fine and is not.
 * SQLite rolls back DDL like anything else, so the table a failed step created
 * goes away with it.
 */
export function migrate(db: DatabaseSync, migrations: Migration[]): MigrationResult {
  ensureLedger(db);

  const done = new Set(
    (db.prepare(`SELECT id FROM ${LEDGER}`).all() as Array<{ id: string }>).map((row) => row.id),
  );
  const pending = [...migrations].sort(byId).filter((migration) => !done.has(migration.id));
  if (pending.length === 0) return { applied: [] };

  const record = db.prepare(`INSERT INTO ${LEDGER} (id, applied_at) VALUES (?, ?)`);
  const appliedAt = new Date().toISOString();

  db.exec("BEGIN");
  try {
    for (const migration of pending) {
      db.exec(migration.sql);
      record.run(migration.id, appliedAt);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { applied: pending.map((migration) => migration.id) };
}
