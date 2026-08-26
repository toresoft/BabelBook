import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { buildReport } from "../main/report/build.ts";

interface SeedOptions {
  events?: Array<[string, string]>;
  identical?: number;
  translated?: number;
  fellBack?: number;
  compose?: unknown;
  terms?: Array<{ source: string; target: string | null; rule: string }>;
}

function seeded(options: SeedOptions = {}) {
  const {
    events = [], identical = 0, translated = 10, fellBack = 0, compose, terms = [],
  } = options;

  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state, layout, cache_key)
    VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','done','reflowable','k1')
  `).run();
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
  db.prepare(`
    INSERT INTO run (id, project_id, phase, started_at, tokens_in, tokens_out)
    VALUES ('r1','p1','compose','2026-08-24',1000,500)
  `).run();

  const unit = db.prepare(`
    INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                      range_start, range_end, state, source_text, raw_text)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const translation = db.prepare(`
    INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome) VALUES (?,?,?,?,?,?)
  `);
  for (let at = 1; at <= translated; at++) {
    const source = `Text ${at}`;
    unit.run(`u${at}`, "p1", "d1", at, `c1.xhtml#${at}`, at, at + 1, "translate", source, source);
    const outcome = at <= identical ? "identical" : at <= identical + fellBack ? "fell-back" : "translated";
    translation.run(`t${at}`, `u${at}`, outcome === "translated" ? `Testo ${at}` : source,
      "k1", 1, outcome);
  }

  const event = db.prepare(`
    INSERT INTO run_event (id, run_id, at, code, severity, payload_json) VALUES (?,?,?,?,?,?)
  `);
  events.forEach(([code, severity], at) => {
    event.run(`e${at}`, "r1", "2026-08-24", code, severity, "{}");
  });

  const term = db.prepare(`
    INSERT INTO term (id, project_id, source, target, rule, origin, approval_state)
    VALUES (?,?,?,?,?,'extracted','approved')
  `);
  terms.forEach((entry, at) => {
    term.run(`tm${at}`, "p1", entry.source, entry.target, entry.rule);
  });

  if (compose !== undefined) {
    db.prepare(`
      INSERT INTO project_phase_result (project_id, phase, cache_key, result_json)
      VALUES ('p1','compose','h',?)
    `).run(JSON.stringify(compose));
  }
  return db;
}

describe("buildReport", () => {
  it("groups events by code and counts them", () => {
    const report = buildReport(
      seeded({ events: [["unit-fell-back", "degradation"], ["unit-fell-back", "degradation"]] }),
      "p1", "r1",
    );

    expect(report.degradations).toEqual([
      expect.objectContaining({ code: "unit-fell-back", count: 2, severity: "degradation" }),
    ]);
  });

  it("keeps declarations apart from degradations", () => {
    const report = buildReport(seeded({ events: [["author-translate-no", "info"]] }), "p1", "r1");

    // A unit that fell back to its source is a defect; a surface the author
    // marked `translate="no"` is correct behaviour. One list for both teaches
    // the reader to ignore it.
    expect(report.degradations).toEqual([]);
    expect(report.declarations.map((line) => line.code)).toEqual(["author-translate-no"]);
  });

  it("is incomplete when there is any degradation, complete when there is none", () => {
    expect(buildReport(seeded({ events: [["unit-fell-back", "degradation"]] }), "p1", "r1").status)
      .toBe("incomplete");
    expect(buildReport(seeded(), "p1", "r1").status).toBe("complete");
  });

  it("is failed when the composition gate refused the book", () => {
    const db = seeded({
      compose: {
        status: "failed",
        outputPath: "/w/output/a.it.epub",
        invariants: [{ id: "I17", name: "no unit vanished", ok: false, details: ["c1.xhtml#1"] }],
        epubcheck: { ran: true, messages: [] },
        overlaysRemoved: { overlays: 0, audio: 0 },
      },
    });

    expect(buildReport(db, "p1", "r1")).toMatchObject({
      status: "failed",
      outputPath: "/w/output/a.it.epub",
    });
  });

  it("carries the invariants the composition actually checked", () => {
    const db = seeded({
      compose: {
        status: "complete",
        outputPath: "/w/output/a.it.epub",
        invariants: [{ id: "I1", name: "same documents", ok: true, details: [] }],
        epubcheck: { ran: false, reason: "no-jar", messages: [] },
        overlaysRemoved: { overlays: 2, audio: 3 },
      },
    });
    const report = buildReport(db, "p1", "r1");

    expect(report.invariants).toHaveLength(1);
    expect(report.epubcheck).toMatchObject({ ran: false, reason: "no-jar" });
    expect(report.overlaysRemoved).toEqual({ overlays: 2, audio: 3 });
  });

  it("says the composition never ran instead of inventing a verdict", () => {
    const report = buildReport(seeded(), "p1", "r1");

    expect(report.invariants).toEqual([]);
    expect(report.epubcheck.ran).toBe(false);
    expect(report.outputPath).toBeNull();
  });

  it("warns when too many translations are identical to the source", () => {
    // Above five per cent it is the symptom of a model handing the input back,
    // which nobody notices by reading a page.
    expect(buildReport(seeded({ identical: 6 }), "p1", "r1").identicalWarning).toBe(true);
    expect(buildReport(seeded({ identical: 0 }), "p1", "r1").identicalWarning).toBe(false);
  });

  it("counts what happened to the units, fallbacks apart from the rest", () => {
    const report = buildReport(seeded({ identical: 2, fellBack: 3 }), "p1", "r1");

    expect(report.units).toMatchObject({
      total: 10, translated: 10, identical: 2, fellBack: 3,
    });
  });

  it("reports the tokens the run actually spent", () => {
    expect(buildReport(seeded(), "p1", "r1").cost)
      .toMatchObject({ tokensIn: 1000, tokensOut: 500 });
  });

  it("measures how well the terminology was honoured, and says when it cannot", () => {
    const respected = buildReport(
      seeded({ terms: [{ source: "Text", target: "Testo", rule: "must" }] }), "p1", "r1",
    );
    expect(respected.terms).toMatchObject({ active: 1 });
    expect(respected.terms.adherence).toMatchObject({ checked: 10, respected: 10 });

    // No terms is not the same fact as "every term was honoured".
    expect(buildReport(seeded(), "p1", "r1").terms.adherence).toBeNull();
  });

  it("notices a term the translation did not honour", () => {
    const report = buildReport(
      seeded({ terms: [{ source: "Text", target: "Nanerottolo", rule: "must" }] }), "p1", "r1",
    );

    expect(report.terms.adherence!.respected).toBe(0);
  });

  it("carries codes, never sentences", () => {
    const report = buildReport(seeded({ events: [["unit-fell-back", "degradation"]] }), "p1", "r1");

    // The phrases are composed by the interface from its catalogue. It is also
    // what makes a report comparable: two different books produce the same codes.
    expect(JSON.stringify(report)).not.toMatch(/fell back to the source/i);
  });
});
