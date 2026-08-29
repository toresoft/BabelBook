import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { readEpub } from "../../core/epub/index.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { SqliteProjectStore } from "../main/db/store.ts";
import { createProject } from "../main/projects/create.ts";
import { makeMachineHost } from "../main/run/machine-host.ts";
import { makeRunRuntime } from "../main/run/runtime.ts";

/**
 * The key the run wrote its work under, which is not the hash of the book.
 * Deliberately unlike `source_sha256`: a composer that asks for the wrong one
 * finds nothing, and finding nothing is not an error it can see.
 */
const KEY = "cache-key-of-the-run";

async function composing() {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-run-compose-"));
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));

  const epubPath = join(dir, "book.epub");
  await writeFile(epubPath, await buildEpub({
    title: "The Book",
    language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two</p>" }],
  }));
  const created = await createProject(db, dir, { epubPath, targetLanguage: "it" });

  // What a run does at its start, and what the composer has to agree with.
  db.prepare("UPDATE project SET cache_key = ?, source_language = 'en' WHERE id = ?")
    .run(KEY, created.id);

  const store = new SqliteProjectStore(db, created.id);
  for (const unit of await store.units()) {
    await store.putTranslation({
      unitId: unit.id, text: `TRADOTTO ${unit.source}`, cacheKey: KEY,
      attempts: 1, outcome: "translated",
    });
  }

  const host = makeMachineHost(db, created.id, {
    hasLanguage: true, autoAcceptTerms: true, autoAcceptExclusions: true,
  });
  for (const type of ["START", "TERMS_READY", "CODE_INDEXED", "TRANSLATED"] as const) {
    host.send({ type });
  }
  expect(makeMachineHost(db, created.id).state).toBe("composing");

  const runtime = makeRunRuntime({
    db,
    settings: () => ({ autoAcceptTerms: true, autoAcceptExclusions: true, concurrency: 2 }),
    backendSpec: () => { throw new Error("the composing path asks no model"); },
    broadcast: () => {},
  });
  return { db, dir, id: created.id, runtime };
}

/**
 * Production break: the composer was handed `source_sha256` where the run's
 * cache key belongs. It named the book instead of the work, no translation
 * answered to it, every unit re-emitted its source, and the book that came out
 * was the English one with Italian metadata on it — with no invariant broken,
 * because a book nothing was translated in is exactly what the composer had
 * been asked for.
 */
describe("the runtime's composition", () => {
  it("composes under the key the run translated with", async () => {
    const { db, dir, id, runtime } = await composing();

    await runtime.start(id);

    const path = (db.prepare("SELECT workspace_path AS p FROM project WHERE id = ?")
      .get(id) as { p: string }).p;
    const written = (db.prepare(
      "SELECT result_json AS json FROM project_phase_result WHERE project_id = ? AND phase = 'compose'",
    ).get(id) as { json: string } | undefined);
    expect(written, "the composition's verdict is kept").toBeDefined();

    const out = JSON.parse(written!.json) as { outputPath: string };
    const epub = await readEpub(await readFile(out.outputPath));
    const doc = epub.get("OEBPS/c1.xhtml")!.toString("utf8");

    expect(doc).toContain("TRADOTTO One");
    expect(doc).not.toContain("<p>One</p>");
    expect(path.startsWith(dir)).toBe(true);
  });
});
