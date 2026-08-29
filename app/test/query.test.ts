import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { BUCKETS, statesOf } from "../shared/buckets.ts";
import { countProjects, listProjects } from "../main/projects/query.ts";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));

  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state, layout, cover_file)
    VALUES ('p1','a.epub','Alpha','/w/p1','h','2026-08-01','it','ready','reflowable','cover.png')
  `).run();
  db.prepare(`
    INSERT INTO project (id, filename, title, author, workspace_path, source_sha256, created_at,
                         source_language, target_language, state, layout)
    VALUES ('p2','b.epub','Beta','King','/w/p2','h','2026-08-02','en','fr','running','pre-paginated')
  `).run();
  return db;
}

function withUnits(db: ReturnType<typeof openDatabase>, translated: number, total: number) {
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
  for (let n = 1; n <= total; n++) {
    db.prepare(`
      INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                        range_start, range_end, state, source_text)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(`u${n}`, "p1", "d1", n, `c1.xhtml#${n}`, n, n + 1, "translate", "x");
    if (n <= translated) {
      db.prepare(`
        INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome)
        VALUES (?,?,?,?,?,?)
      `).run(`t${n}`, `u${n}`, "tradotto", "k1", 1, "translated");
    }
  }
}

/**
 * The whole machine in one library: eleven projects, one per state.
 *
 * Every group then holds exactly the members the map gives it, so a state
 * that quietly falls out of its group shows up as a count that is wrong by
 * one, not as a screen that looks plausible.
 */
async function aLibraryOfEveryState() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));

  const states = [
    "new", "needs-language", "ready", "running", "waiting-terms", "waiting-code",
    "composing", "paused", "done", "incomplete", "failed",
  ];
  const insert = db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  for (const [n, state] of states.entries()) {
    insert.run(`p${n}`, `${state}.epub`, state, `/w/p${n}`, "h", "2026-08-01", "it", state);
  }
  return db;
}

describe("listProjects", () => {
  it("returns the newest first", () => {
    expect(listProjects(seeded()).map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("filters by title, case-insensitively", () => {
    expect(listProjects(seeded(), { search: "alp" }).map((p) => p.id)).toEqual(["p1"]);
  });

  it("carries what the library needs to draw a tile", () => {
    const beta = listProjects(seeded()).find((p) => p.id === "p2")!;

    expect(beta).toMatchObject({
      title: "Beta", author: "King", sourceLanguage: "en", targetLanguage: "fr",
      state: "running", layout: "pre-paginated", coverPath: null,
    });
  });

  it("addresses the cover through the protocol, never as a path on disk", () => {
    const alpha = listProjects(seeded()).find((p) => p.id === "p1")!;

    expect(alpha.coverPath).toBe("app://cover/p1/cover.png");
    expect(alpha.coverPath).not.toContain("/w/p1");
  });

  it("computes progress from the units, in one query", () => {
    const db = seeded();
    withUnits(db, 1, 4);

    expect(listProjects(db).find((p) => p.id === "p1")!.progress).toEqual({ done: 1, total: 4 });
  });

  it("counts only the units that are work, and only translations under one key", () => {
    const db = seeded();
    withUnits(db, 2, 3);
    db.prepare(`
      INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                        range_start, range_end, state, source_text)
      VALUES ('uc','p1','d1',99,'c1.xhtml#99',0,1,'code','x = 1')
    `).run();
    db.prepare(`
      INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome)
      VALUES ('tx','u1','altra chiave','k2',1,'translated')
    `).run();

    expect(listProjects(db).find((p) => p.id === "p1")!.progress).toEqual({ done: 2, total: 3 });
  });

  it("does not count a fallback as progress: the unit still holds its source", () => {
    const db = seeded();
    withUnits(db, 1, 3);
    db.prepare(`
      INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome)
      VALUES ('tf','u2','x','k1',3,'fell-back')
    `).run();

    expect(listProjects(db).find((p) => p.id === "p1")!.progress).toEqual({ done: 1, total: 3 });
  });

  it("says zero of zero for a project with no units yet", () => {
    expect(listProjects(seeded()).find((p) => p.id === "p2")!.progress).toEqual({ done: 0, total: 0 });
  });

  it("asks the database once, however many projects there are", () => {
    const db = seeded();
    let prepared = 0;
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      prepared++;
      return original(sql);
    };

    listProjects(db);
    expect(prepared).toBe(1);
  });
});

/**
 * Eleven states, five names.
 *
 * The grouping is the only thing the column teaches, so it is the thing worth
 * pinning: a state that quietly falls out of its group makes a project
 * invisible to the person looking for it.
 */
describe("the groups of the library", () => {
  it("puts the two gates together, and nothing else with them", () => {
    expect([...statesOf("to-approve")].sort()).toEqual(["waiting-code", "waiting-terms"]);
  });

  it("counts composing as running, because the book is still moving", () => {
    expect([...statesOf("running")].sort()).toEqual(["composing", "running"]);
  });

  it("filters the library to the group asked for", async () => {
    const db = await aLibraryOfEveryState();

    const gates = listProjects(db, { bucket: "to-approve" });
    const all = listProjects(db, { bucket: "all" });

    expect(gates.map((p) => p.state).sort()).toEqual(["waiting-code", "waiting-terms"]);
    expect(all).toHaveLength(11);
  });

  it("counts each group, and counts every project under Projects", async () => {
    const db = await aLibraryOfEveryState();

    const counts = countProjects(db);

    expect(counts.all).toBe(11);
    expect(counts["to-approve"]).toBe(2);
    expect(counts.running).toBe(2);
    expect(counts.paused).toBe(1);
    expect(counts.done).toBe(1);
    // The groups do not partition, and that is deliberate: five of the eleven
    // live only under Projects.
    expect(BUCKETS.reduce((n, b) => n + (b === "all" ? 0 : counts[b]), 0)).toBe(6);
  });
});
