import { describe, expect, it } from "vitest";
import { parseGlossary } from "../../core/glossary/index.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import {
  attachToProject, deleteGlossary, exportGlossary, importGlossary, listGlossaries, saveGlossary,
} from "../main/glossaries/store.ts";

const markdown = `---
name: fantasy
version: 2
description: Epic fantasy with invented names
sourceLanguage: en
targetLanguage: it
---

| source | target | rule | note |
|---|---|---|---|
| Rivendell |  | dnt | place name |
| hobbit | hobbit | prefer |  |
`;

function db() {
  const d = openDatabase(":memory:");
  migrate(d, loadMigrations("app/main/db/migrations"));
  return d;
}

function project(d: ReturnType<typeof db>, id: string) {
  d.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state)
    VALUES (?,'a.epub','A','/w','h','2026-08-24','it','ready')
  `).run(id);
}

describe("glossaries", () => {
  it("imports the format the prototype wrote, unchanged", () => {
    const d = db();
    const glossary = importGlossary(d, markdown);

    expect(glossary).toMatchObject({ name: "fantasy", version: 2, sourceLanguage: "en" });
    expect(listGlossaries(d)).toHaveLength(1);
  });

  it("round-trips through export, the third rule included", () => {
    const d = db();
    importGlossary(d, markdown);
    const back = parseGlossary(exportGlossary(d, listGlossaries(d)[0]!.id));

    expect(back.terms).toEqual(parseGlossary(markdown).terms);
    expect(back.terms.find((term) => term.source === "hobbit")?.rule).toBe("prefer");
  });

  it("bumps the version when the terms change, and not when only the description does", () => {
    const d = db();
    const glossary = importGlossary(d, markdown);

    // Fixing a typo in a description must not invalidate the translations of
    // every book that uses the glossary; changing the terms must.
    const described = saveGlossary(d, { ...glossary, description: "Better description" });
    expect(described.version).toBe(2);

    const grown = saveGlossary(d, {
      ...described,
      terms: [...described.terms, { source: "Mordor", rule: "dnt" as const, origin: "glossary" as const }],
    });
    expect(grown.version).toBe(3);
  });

  it("bumps the version when a rendering changes, not only when one is added", () => {
    const d = db();
    const glossary = importGlossary(d, markdown);
    const changed = saveGlossary(d, {
      ...glossary,
      terms: glossary.terms.map((term) =>
        term.source === "hobbit" ? { ...term, target: "hobbit italiano" } : term),
    });

    expect(changed.version).toBe(3);
  });

  it("detaches a deleted glossary from the projects that used it, and says how many", () => {
    const d = db();
    const glossary = importGlossary(d, markdown);
    project(d, "p1");
    attachToProject(d, "p1", glossary.id, "user");

    // A project that loses its terminology in silence is a book that changes
    // register halfway through with no explanation.
    expect(deleteGlossary(d, glossary.id)).toEqual({ detachedFrom: 1 });
    expect(listGlossaries(d)).toEqual([]);
  });

  it("records who chose a glossary for a project, and does not double the row", () => {
    const d = db();
    const glossary = importGlossary(d, markdown);
    project(d, "p1");

    attachToProject(d, "p1", glossary.id, "vote");
    attachToProject(d, "p1", glossary.id, "user");

    expect(d.prepare("SELECT chosen_by FROM project_glossary WHERE project_id='p1'").all())
      .toEqual([{ chosen_by: "user" }]);
  });

  it("refuses a glossary whose languages do not parse", () => {
    expect(() => importGlossary(db(), markdown.replace("sourceLanguage: en", "sourceLanguage:")))
      .toThrow(/MISSING_LANGUAGES/);
  });

  it("leaves nothing behind when an import fails halfway", () => {
    const d = db();
    expect(() => importGlossary(d, markdown.replace("version: 2", "version: zero"))).toThrow();

    expect(listGlossaries(d)).toEqual([]);
  });

  it("refuses to export a glossary that is not there", () => {
    expect(() => exportGlossary(db(), "ghost")).toThrow(/GLOSSARY_UNKNOWN/);
  });
});
