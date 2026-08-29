import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { clearForced, forceState, listExclusions } from "../main/exclusions/review.ts";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state)
    VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','waiting-code')
  `).run();
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();

  const rows: Array<[string, string, string, string | null]> = [
    ["u1", "gem install foo", "code", "css-code-surface"],
    ["u2", "The src/ directory holds the sources", "code", "css-code-surface"],
    ["u3", "Acme Corp", "translate-no", null],
    ["u4", "A normal sentence", "translate", null],
  ];
  const insert = db.prepare(`
    INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                      range_start, range_end, state, reason, source_text, raw_text)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  rows.forEach(([id, text, state, reason], at) => {
    insert.run(id, "p1", "d1", at + 1, `c1.xhtml#${at + 1}`, at, at + 1, state, reason, text, text);
  });
  return db;
}

describe("exclusions", () => {
  it("groups what will not be translated by state and reason", () => {
    const groups = listExclusions(seeded(), "p1");

    // Grouped because that is how it is read: "forty blocks excluded by the
    // stylesheet" is one question, not forty.
    expect(groups.map((group) => group.state).sort()).toEqual(["code", "translate-no"]);
    expect(groups.find((group) => group.state === "code")).toMatchObject({
      reason: "css-code-surface",
    });
    expect(groups.find((group) => group.state === "code")?.units).toHaveLength(2);
  });

  it("carries the text, so the user can judge without opening the book", () => {
    const groups = listExclusions(seeded(), "p1");
    const code = groups.find((group) => group.state === "code")!;

    expect(code.units.map((unit) => unit.text)).toContain("gem install foo");
    expect(code.units.every((unit) => !unit.forced)).toBe(true);
  });

  it("does not list units that are going to be translated", () => {
    expect(listExclusions(seeded(), "p1").flatMap((group) => group.units.map((unit) => unit.unitId)))
      .not.toContain("c1.xhtml#4");
  });

  it("frees a block the user says is prose", () => {
    const db = seeded();

    expect(forceState(db, "p1", [{ unitId: "c1.xhtml#2", state: "translate" }]))
      .toEqual({ toTranslate: 1, toCode: 0 });
    expect(db.prepare("SELECT forced_state, forced_by FROM unit WHERE id='u2'").get())
      .toMatchObject({ forced_state: "translate", forced_by: "user" });
  });

  it("protects a block the user says is code", () => {
    const db = seeded();

    expect(forceState(db, "p1", [{ unitId: "c1.xhtml#4", state: "code" }]))
      .toEqual({ toTranslate: 0, toCode: 1 });
  });

  it("keeps the original state alongside the forced one, so a change can be undone", () => {
    const db = seeded();
    forceState(db, "p1", [{ unitId: "c1.xhtml#2", state: "translate" }]);

    expect(clearForced(db, "p1", ["c1.xhtml#2"])).toEqual({ cleared: 1 });
    expect(db.prepare("SELECT state, forced_state, forced_by FROM unit WHERE id='u2'").get())
      .toMatchObject({ state: "code", forced_state: null, forced_by: null });
  });

  // Without this the screen is a trap: freeing a block makes it vanish, and
  // there is nowhere left to undo it from.
  it("still shows a freed block, marked as the user's doing", () => {
    const db = seeded();
    forceState(db, "p1", [{ unitId: "c1.xhtml#2", state: "translate" }]);

    const found = listExclusions(db, "p1")
      .flatMap((group) => group.units)
      .find((unit) => unit.unitId === "c1.xhtml#2");
    expect(found).toMatchObject({ forced: true });
  });

  it("shows a block the user protected, which nothing had excluded", () => {
    const db = seeded();
    forceState(db, "p1", [{ unitId: "c1.xhtml#4", state: "code" }]);

    // It lands in a `code` group of its own: the deduced ones carry the reason
    // that excluded them, and this one has none because nothing did.
    const groups = listExclusions(db, "p1").filter((group) => group.state === "code");
    expect(groups.find((group) => group.reason === null)?.units.map((unit) => unit.unitId))
      .toEqual(["c1.xhtml#4"]);
  });

  it("refuses a unit that is not in this project, changing nothing", () => {
    const db = seeded();

    expect(() => forceState(db, "p1", [
      { unitId: "c1.xhtml#2", state: "translate" },
      { unitId: "ghost", state: "translate" },
    ])).toThrow(/UNIT_UNKNOWN/);
    expect(db.prepare("SELECT forced_state FROM unit WHERE id='u2'").get())
      .toMatchObject({ forced_state: null });
  });

  it("reports nothing cleared when there was nothing forced", () => {
    expect(clearForced(seeded(), "p1", ["c1.xhtml#1"])).toEqual({ cleared: 0 });
  });

  it("shows the code of a listing, and where it is", () => {
    const db = seeded();
    db.prepare(`
      INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                        range_start, range_end, state, source_text, raw_text)
      VALUES ('u5','p1','d1',5,'c1.xhtml#5',9,10,'code','<0></0>','<code>const a = 1;</code>')
    `).run();

    const groups = listExclusions(db, "p1");
    const listing = groups.flatMap((group) => group.units).find((unit) => unit.unitId === "c1.xhtml#5")!;

    expect(listing.text).toBe("const a = 1;");
    expect(listing.ordinal).toBe(5);
  });

  /**
   * Grouped by state and reason alone, a technical book is one group of twelve
   * hundred rows. The document is what turns that back into questions a person
   * can answer one at a time.
   */
  it("splits the groups by document", () => {
    const db = seeded();
    db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d2','p1','c2.xhtml',2)").run();
    db.prepare(`
      INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                        range_start, range_end, state, reason, source_text, raw_text)
      VALUES ('u5','p1','d2',1,'c2.xhtml#1',0,1,'code','css-code-surface','x','x')
    `).run();

    const docs = listExclusions(db, "p1")
      .filter((group) => group.reason === "css-code-surface")
      .map((group) => group.doc);

    expect(new Set(docs)).toEqual(new Set(["c1.xhtml", "c2.xhtml"]));
  });
});
