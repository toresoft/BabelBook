import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { addManualTerm, decideTerms, listTerms, promoteToGlossary } from "../main/terms/approve.ts";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state)
    VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','waiting-terms')
  `).run();

  const term = db.prepare(`
    INSERT INTO term (id, project_id, source, target, rule, origin, approval_state, sense)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  term.run("t1", "p1", "Rivendell", null, "dnt", "extracted", "pending", null);
  term.run("t2", "p1", "dwarf", "nano", "must", "extracted", "pending", "the fantasy people");
  // A third rule exists and is the most common one in real glossaries; a
  // fixture with only the two the plan knew about would let `prefer` break
  // anywhere downstream without a test noticing.
  term.run("t3", "p1", "hobbit", "hobbit", "prefer", "extracted", "pending", null);

  db.prepare(`
    INSERT INTO glossary (id, name, description, source_language, target_language, version)
    VALUES ('g1','fantasy','Epic fantasy','en','it',1)
  `).run();
  return db;
}

describe("terms", () => {
  it("lists what is pending, with what the user needs to judge it", () => {
    const pending = listTerms(seeded(), "p1").filter((term) => term.approval === "pending");

    expect(pending).toHaveLength(3);
    expect(pending.find((term) => term.id === "t2")).toMatchObject({
      source: "dwarf", target: "nano", rule: "must", sense: "the fantasy people",
    });
  });

  it("records a decision and the edited rendering together", () => {
    const db = seeded();
    const counts = decideTerms(db, "p1", [
      { id: "t1", approval: "approved" },
      { id: "t2", approval: "approved", target: "nanerottolo" },
    ]);

    expect(counts).toEqual({ approved: 2, rejected: 0 });
    expect(listTerms(db, "p1").find((term) => term.id === "t2")?.target).toBe("nanerottolo");
  });

  it("changes the rule when the user disagrees with the one proposed", () => {
    const db = seeded();
    decideTerms(db, "p1", [{ id: "t3", approval: "approved", rule: "must" }]);

    expect(listTerms(db, "p1").find((term) => term.id === "t3")?.rule).toBe("must");
  });

  it("keeps a rejected term instead of deleting it, so it is not proposed again", () => {
    const db = seeded();
    decideTerms(db, "p1", [{ id: "t1", approval: "rejected" }]);

    expect(listTerms(db, "p1").find((term) => term.id === "t1")?.approval).toBe("rejected");
  });

  it("decides all of them or none, so a half-approved gate cannot be saved", () => {
    const db = seeded();

    expect(() => decideTerms(db, "p1", [
      { id: "t1", approval: "approved" },
      { id: "ghost", approval: "approved" },
    ])).toThrow(/TERM_UNKNOWN/);
    expect(listTerms(db, "p1").find((term) => term.id === "t1")?.approval).toBe("pending");
  });

  it("accepts a term the user typed, already approved", () => {
    const db = seeded();
    const term = addManualTerm(db, "p1", { source: "Bag End", target: null, rule: "dnt", note: null });

    expect(term).toMatchObject({ origin: "manual", approval: "approved", source: "Bag End" });
  });

  it("bumps the glossary version when a term is promoted into it", () => {
    const db = seeded();
    decideTerms(db, "p1", [{ id: "t1", approval: "approved" }]);

    expect(promoteToGlossary(db, "t1", "g1").version).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM glossary_term WHERE glossary_id='g1'")
      .get()).toMatchObject({ n: 1 });
  });

  // Production break: `prefer` was added to `term` and not to `glossary_term`,
  // so promoting the commonest kind of rule hits a CHECK constraint.
  it("promotes a preferred rendering, which is most of what a real glossary holds", () => {
    const db = seeded();
    decideTerms(db, "p1", [{ id: "t3", approval: "approved" }]);
    promoteToGlossary(db, "t3", "g1");

    expect(db.prepare("SELECT rule, target FROM glossary_term WHERE glossary_id='g1'").get())
      .toMatchObject({ rule: "prefer", target: "hobbit" });
  });

  it("promoting the same term twice updates it without bumping twice", () => {
    const db = seeded();
    decideTerms(db, "p1", [{ id: "t2", approval: "approved", target: "nanerottolo" }]);
    promoteToGlossary(db, "t2", "g1");
    const second = promoteToGlossary(db, "t2", "g1");

    expect(second.version).toBe(3);
    expect(db.prepare("SELECT count(*) AS n FROM glossary_term WHERE glossary_id='g1'")
      .get()).toMatchObject({ n: 1 });
  });

  it("refuses to promote a term nobody approved", () => {
    const db = seeded();
    expect(() => promoteToGlossary(db, "t2", "g1")).toThrow(/NOT_APPROVED/);
  });

  it("refuses a glossary that is not there, without touching the term", () => {
    const db = seeded();
    decideTerms(db, "p1", [{ id: "t1", approval: "approved" }]);

    expect(() => promoteToGlossary(db, "t1", "ghost")).toThrow(/GLOSSARY_UNKNOWN/);
  });
});
