import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { projectCacheKey } from "../main/run/cache-key.ts";

function database(): DatabaseSync {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         source_language, target_language, state)
    VALUES ('p1','a.epub','A','/w','sha-of-the-book','2026-08-28','en','it','ready')
  `).run();
  return db;
}

function attach(db: DatabaseSync, name: string, version: number): void {
  db.prepare("INSERT INTO glossary (id, name, version) VALUES (?,?,?)").run(name, name, version);
  db.prepare("INSERT INTO project_glossary (project_id, glossary_id) VALUES ('p1', ?)").run(name);
}

describe("projectCacheKey", () => {
  it("is a digest, and the same inputs always give the same one", () => {
    const db = database();

    expect(projectCacheKey(db, "p1", "openai-compatible:m1"))
      .toBe(projectCacheKey(db, "p1", "openai-compatible:m1"));
    expect(projectCacheKey(db, "p1", "openai-compatible:m1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the model changes, because another model is other work", () => {
    const db = database();

    expect(projectCacheKey(db, "p1", "openai-compatible:m1"))
      .not.toBe(projectCacheKey(db, "p1", "openai-compatible:m2"));
  });

  it("changes when the book itself changes", () => {
    const db = database();
    const before = projectCacheKey(db, "p1", "acme:m1");
    db.prepare("UPDATE project SET source_sha256 = 'another-book' WHERE id = 'p1'").run();

    expect(projectCacheKey(db, "p1", "acme:m1")).not.toBe(before);
  });

  it("changes when a glossary is attached or its version moves", () => {
    const db = database();
    const bare = projectCacheKey(db, "p1", "acme:m1");

    attach(db, "fantasy", 1);
    const withGlossary = projectCacheKey(db, "p1", "acme:m1");
    expect(withGlossary).not.toBe(bare);

    db.prepare("UPDATE glossary SET version = 2 WHERE id = 'fantasy'").run();
    expect(projectCacheKey(db, "p1", "acme:m1")).not.toBe(withGlossary);
  });

  it("carries the prompt contract, so work made under an older one is not reused", () => {
    const db = database();
    // The whole point of the key: raising PROMPT_VERSION must move it. Without
    // this the engine would hand back translations produced under instructions
    // that have since been rewritten, and nobody would find it by reading.
    expect(projectCacheKey(db, "p1", "acme:m1", { prompt: 1, context: 1 }))
      .not.toBe(projectCacheKey(db, "p1", "acme:m1", { prompt: 2, context: 1 }));
  });

  it("does not depend on the order the glossaries were attached in", () => {
    const first = database();
    attach(first, "fantasy", 1);
    attach(first, "tech", 3);

    const second = database();
    attach(second, "tech", 3);
    attach(second, "fantasy", 1);

    expect(projectCacheKey(first, "p1", "acme:m1")).toBe(projectCacheKey(second, "p1", "acme:m1"));
  });
});
