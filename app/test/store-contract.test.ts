import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runProjectStoreContract } from "../../core/test/contract/project-store.ts";
import type { TranslationUnit } from "../../core/epub/index.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { SqliteProjectStore } from "../main/db/store.ts";

/** A project with a run, and the units the battery asked to be seeded. */
function seeded(units: TranslationUnit[]) {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));

  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256,
                         created_at, target_language, state)
    VALUES ('p1', 'book.epub', 'Book', '/w', 'hash', '2026-08-25', 'it', 'ready')
  `).run();
  db.prepare("INSERT INTO run (id, project_id, phase, started_at) VALUES ('r1','p1','translate','2026-08-25')").run();

  const documents = new Map<string, string>();
  for (const unit of units) {
    if (documents.has(unit.doc)) continue;
    const id = randomUUID();
    documents.set(unit.doc, id);
    db.prepare(
      "INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES (?,?,?,?)",
    ).run(id, "p1", unit.doc, documents.size);
  }

  for (const unit of units) {
    db.prepare(`
      INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, kind,
                        range_start, range_end, state, source_text, raw_text, placeholders)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(randomUUID(), "p1", documents.get(unit.doc)!, unit.ordinal, unit.id, unit.kind,
      unit.range[0], unit.range[1], unit.state, unit.source, unit.raw,
      unit.placeholders === undefined ? null : JSON.stringify(unit.placeholders));
  }

  return db;
}

runProjectStoreContract("SqliteProjectStore", async (units) =>
  new SqliteProjectStore(seeded(units), "p1", "r1"));

describe("SqliteProjectStore, beyond the contract", () => {
  it("reports a forced state instead of the deduced one, without erasing it", async () => {
    const db = seeded([{
      id: "c1.xhtml#1", kind: "block", doc: "c1.xhtml", ordinal: 1, range: [0, 5],
      source: "gem install foo", raw: "gem install foo", state: "code",
    }]);
    db.prepare("UPDATE unit SET forced_state = 'translate', forced_by = 'user'").run();

    const store = new SqliteProjectStore(db, "p1", "r1");
    expect((await store.units())[0].state).toBe("translate");

    const row = db.prepare("SELECT state FROM unit").get() as { state: string };
    expect(row.state).toBe("code");
  });

  it("keeps the bytes of the range apart from the decoded text", async () => {
    const db = seeded([{
      id: "c1.xhtml#1", kind: "block", doc: "c1.xhtml", ordinal: 1, range: [0, 9],
      source: "a & b", raw: "a &#38; b", state: "translate",
    }]);

    const [unit] = await new SqliteProjectStore(db, "p1", "r1").units();
    expect(unit.source).toBe("a & b");
    expect(unit.raw).toBe("a &#38; b");
  });

  it("hands the engine approved terms only", async () => {
    const db = seeded([]);
    db.prepare(`
      INSERT INTO term (id, project_id, source, target, rule, origin, approval_state)
      VALUES ('t1','p1','Rivendell',NULL,'dnt','extracted','pending')
    `).run();

    expect(await new SqliteProjectStore(db, "p1", "r1").terms()).toEqual([]);
  });

  it("refuses an event it cannot attribute to a run", async () => {
    const store = new SqliteProjectStore(seeded([]), "p1");
    await expect(store.event({ code: "unit-fell-back", severity: "degradation", payload: {} }))
      .rejects.toThrow(/no run/);
  });

  it("refuses to translate a unit that belongs to another project", async () => {
    const store = new SqliteProjectStore(seeded([]), "p1", "r1");
    await expect(store.putTranslation({
      unitId: "ghost.xhtml#1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated",
    })).rejects.toThrow(/not found/);
  });
});
