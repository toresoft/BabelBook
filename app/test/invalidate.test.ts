import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { applyInvalidation, previewInvalidation } from "../main/terms/invalidate.ts";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state)
    VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','running')
  `).run();
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();

  const unit = db.prepare(`
    INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                      range_start, range_end, state, source_text, raw_text)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const translation = db.prepare(`
    INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome) VALUES (?,?,?,?,?,?)
  `);
  ["The road to Rivendell", "A quiet evening", "Rivendell again"].forEach((text, at) => {
    unit.run(`u${at + 1}`, "p1", "d1", at + 1, `c1.xhtml#${at + 1}`, at, at + 1, "translate", text, text);
    translation.run(`tr${at + 1}`, `u${at + 1}`, `traduzione ${at + 1}`, "k1", 1, "translated");
  });

  db.prepare(`
    INSERT INTO term (id, project_id, source, target, rule, origin, approval_state)
    VALUES ('t1','p1','Rivendell',NULL,'dnt','extracted','approved')
  `).run();
  return db;
}

describe("invalidation", () => {
  it("names only the units that contain the changed term", () => {
    expect(previewInvalidation(seeded(), "p1", ["t1"]).units.sort())
      .toEqual(["c1.xhtml#1", "c1.xhtml#3"]);
  });

  it("says nothing is affected when the term appears nowhere", () => {
    const db = seeded();
    db.prepare("UPDATE term SET source='Mordor' WHERE id='t1'").run();

    expect(previewInvalidation(db, "p1", ["t1"]).units).toEqual([]);
  });

  // The preview exists so the confirmation is informed: the screen says "this
  // retranslates 34 units" before anything is spent.
  it("estimates what redoing them would cost, from the units themselves", () => {
    const preview = previewInvalidation(seeded(), "p1", ["t1"]);

    expect(preview.cost).not.toBeNull();
    expect(preview.cost!.tokensIn).toBeGreaterThan(0);
    expect(preview.cost!.tokensOut).toBeGreaterThan(0);
  });

  it("costs nothing when nothing is affected", () => {
    const db = seeded();
    db.prepare("UPDATE term SET source='Mordor' WHERE id='t1'").run();

    expect(previewInvalidation(db, "p1", ["t1"]).cost).toBeNull();
  });

  it("removes only the named translations, and keeps the rest", () => {
    const db = seeded();

    expect(applyInvalidation(db, "p1", ["c1.xhtml#1", "c1.xhtml#3"], "k1")).toEqual({ removed: 2 });
    expect(db.prepare("SELECT count(*) AS n FROM translation WHERE cache_key='k1'").get())
      .toMatchObject({ n: 1 });
  });

  it("does not touch translations stored under another cache key", () => {
    const db = seeded();
    db.prepare(`
      INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome)
      VALUES ('other','u1','altra','k2',1,'translated')
    `).run();

    applyInvalidation(db, "p1", ["c1.xhtml#1"], "k1");

    expect(db.prepare("SELECT count(*) AS n FROM translation WHERE cache_key='k2'").get())
      .toMatchObject({ n: 1 });
  });

  it("does not touch another project's units that happen to share an id", () => {
    const db = seeded();
    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           target_language, state)
      VALUES ('p2','b.epub','B','/w2','h2','2026-08-24','it','running')
    `).run();
    db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d2','p2','c1.xhtml',1)").run();
    db.prepare(`
      INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                        range_start, range_end, state, source_text, raw_text)
      VALUES ('v1','p2','d2',1,'c1.xhtml#1',0,1,'translate','Other book','Other book')
    `).run();
    db.prepare(`
      INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome)
      VALUES ('otr','v1','intatta','k1',1,'translated')
    `).run();

    // Unit ids are `${doc}#${ordinal}` and only unique within a project: two
    // books both having a `c1.xhtml#1` is the normal case, not a strange one.
    applyInvalidation(db, "p1", ["c1.xhtml#1"], "k1");

    expect(db.prepare("SELECT count(*) AS n FROM translation WHERE unit_id='v1'").get())
      .toMatchObject({ n: 1 });
  });

  it("reports nothing removed when the translations were already gone", () => {
    const db = seeded();
    applyInvalidation(db, "p1", ["c1.xhtml#1"], "k1");

    expect(applyInvalidation(db, "p1", ["c1.xhtml#1"], "k1")).toEqual({ removed: 0 });
  });
});
