import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseGlossary, serializeGlossary } from "../../../core/glossary/index.ts";
import type { GlossaryTerm, GlossaryView } from "../../shared/dto.ts";

export type { GlossaryTerm, GlossaryView } from "../../shared/dto.ts";

/** Thrown with a code, never with a sentence: the interface owns the words. */
export class GlossaryStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GlossaryStoreError";
    this.code = code;
  }
}

interface GlossaryRow {
  id: string;
  name: string;
  description: string | null;
  source_language: string | null;
  target_language: string | null;
  version: number;
}

interface TermRow {
  glossary_id: string;
  source: string;
  target: string | null;
  rule: GlossaryTerm["rule"];
  sense: string | null;
  note: string | null;
}

function termsOf(db: DatabaseSync, glossaryId: string): GlossaryTerm[] {
  const rows = db.prepare(
    "SELECT source, target, rule, sense, note FROM glossary_term WHERE glossary_id = ? ORDER BY source",
  ).all(glossaryId) as unknown as TermRow[];

  // Absent rather than null, because that is what `TermEntry` says and what
  // `serializeGlossary` writes: a `target: null` would round-trip into an
  // empty cell that parses back as no target at all.
  return rows.map((row) => ({
    source: row.source,
    ...(row.target === null || row.target === "" ? {} : { target: row.target }),
    rule: row.rule,
    ...(row.sense === null ? {} : { sense: row.sense }),
    ...(row.note === null ? {} : { note: row.note }),
    origin: "glossary" as const,
  }));
}

function toView(db: DatabaseSync, row: GlossaryRow): GlossaryView {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description ?? "",
    sourceLanguage: row.source_language ?? "",
    targetLanguage: row.target_language ?? "",
    terms: termsOf(db, row.id),
  };
}

export function listGlossaries(db: DatabaseSync): GlossaryView[] {
  const rows = db.prepare(
    "SELECT id, name, description, source_language, target_language, version FROM glossary ORDER BY name",
  ).all() as unknown as GlossaryRow[];
  return rows.map((row) => toView(db, row));
}

export function getGlossary(db: DatabaseSync, id: string): GlossaryView | null {
  const row = db.prepare(
    "SELECT id, name, description, source_language, target_language, version FROM glossary WHERE id = ?",
  ).get(id) as unknown as GlossaryRow | undefined;
  return row === undefined ? null : toView(db, row);
}

/** The terms, in a shape two lists can be compared by. */
function fingerprint(terms: GlossaryTerm[]): string {
  return JSON.stringify([...terms]
    .sort((a, b) => a.source.localeCompare(b.source))
    .map((term) => [term.source, term.target ?? "", term.rule, term.sense ?? "", term.note ?? ""]));
}

function writeTerms(db: DatabaseSync, glossaryId: string, terms: GlossaryTerm[]): void {
  db.prepare("DELETE FROM glossary_term WHERE glossary_id = ?").run(glossaryId);
  const insert = db.prepare(`
    INSERT INTO glossary_term (id, glossary_id, source, target, rule, sense, note)
    VALUES (?,?,?,?,?,?,?)
  `);
  for (const term of terms) {
    insert.run(
      randomUUID(), glossaryId, term.source, term.target ?? null, term.rule,
      term.sense ?? null, term.note ?? null,
    );
  }
}

/**
 * Saves a glossary, and moves its version only when the terms moved.
 *
 * The version rides in the cache key. Bumping it on every save would make
 * fixing a typo in a description invalidate the translations of every book
 * that uses the glossary — an expensive answer to a change that asks the model
 * nothing new. Changing the terms is exactly the case the version exists for,
 * and a changed rendering counts as much as an added entry.
 */
export function saveGlossary(db: DatabaseSync, glossary: GlossaryView): GlossaryView {
  const current = getGlossary(db, glossary.id);
  const termsChanged = current === null || fingerprint(current.terms) !== fingerprint(glossary.terms);
  const version = current === null
    ? glossary.version
    : termsChanged ? current.version + 1 : current.version;

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO glossary (id, name, description, source_language, target_language, version)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, description = excluded.description,
        source_language = excluded.source_language, target_language = excluded.target_language,
        version = excluded.version
    `).run(
      glossary.id, glossary.name, glossary.description,
      glossary.sourceLanguage, glossary.targetLanguage, version,
    );
    if (termsChanged) writeTerms(db, glossary.id, glossary.terms);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getGlossary(db, glossary.id)!;
}

/**
 * Removes a glossary and says how many projects it was taken from.
 *
 * Declared, not silent: a project that loses its terminology without a word is
 * a book that changes register halfway through and nobody knows why.
 */
export function deleteGlossary(db: DatabaseSync, id: string): { detachedFrom: number } {
  const attached = db.prepare("SELECT count(*) AS n FROM project_glossary WHERE glossary_id = ?")
    .get(id) as { n: number };

  // `project_glossary` and `glossary_term` both cascade, so the delete is the
  // detach; the count is read first because afterwards there is nothing to count.
  db.prepare("DELETE FROM glossary WHERE id = ?").run(id);
  return { detachedFrom: Number(attached.n) };
}

/**
 * Reads the format the prototype wrote, unchanged.
 *
 * Same parser as the core's, so glossaries written by hand years ago load
 * without being rewritten. Parsing happens before the transaction opens: a
 * malformed file must leave no half-imported glossary behind.
 */
export function importGlossary(db: DatabaseSync, markdown: string): GlossaryView {
  const parsed = parseGlossary(markdown);
  const id = randomUUID();

  return saveGlossary(db, {
    id,
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    sourceLanguage: parsed.sourceLanguage,
    targetLanguage: parsed.targetLanguage,
    terms: parsed.terms as GlossaryTerm[],
  });
}

export function exportGlossary(db: DatabaseSync, id: string): string {
  const glossary = getGlossary(db, id);
  if (glossary === null) throw new GlossaryStoreError("GLOSSARY_UNKNOWN", `no glossary ${id}`);

  return serializeGlossary({
    name: glossary.name,
    version: glossary.version,
    description: glossary.description,
    sourceLanguage: glossary.sourceLanguage,
    targetLanguage: glossary.targetLanguage,
    terms: glossary.terms,
  });
}

/**
 * Says this project uses this glossary, and who decided so.
 *
 * The user's choice overwrites the vote's rather than adding a second row: a
 * project either uses a glossary or it does not, and two answers to that would
 * make the cache key depend on which one was read first.
 */
export function attachToProject(
  db: DatabaseSync, projectId: string, glossaryId: string, chosenBy: "vote" | "user",
): void {
  db.prepare(`
    INSERT INTO project_glossary (project_id, glossary_id, chosen_by) VALUES (?,?,?)
    ON CONFLICT (project_id, glossary_id) DO UPDATE SET chosen_by = excluded.chosen_by
  `).run(projectId, glossaryId, chosenBy);
}

export function detachFromProject(db: DatabaseSync, projectId: string, glossaryId: string): void {
  db.prepare("DELETE FROM project_glossary WHERE project_id = ? AND glossary_id = ?")
    .run(projectId, glossaryId);
}
