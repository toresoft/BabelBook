import type { DatabaseSync } from "node:sqlite";
import { cacheKey, CONTEXT_VERSION, PROMPT_VERSION, type Versions } from "../../../core/translate/versions.ts";

/**
 * The key a project's translations may be reused under, read from its own row.
 *
 * The core declares what goes into the key and how it is digested; this is the
 * only place that knows where those parts live in the database. Splitting it
 * that way is what lets the rule be tested without a run, an engine or a
 * provider — the arrangement the core was written for.
 *
 * Before this existed, the run used the source hash alone. That answered one
 * question correctly — has the book changed — and stayed silent on the three
 * that matter as much: a different model, other languages, a rewritten prompt.
 * Work made under any of them came back as finished, which is the failure the
 * comment in `versions.ts` was written to prevent and the one that happened.
 */
export function projectCacheKey(
  db: DatabaseSync,
  projectId: string,
  modelId: string,
  versions: Versions = { prompt: PROMPT_VERSION, context: CONTEXT_VERSION },
): string {
  const row = db.prepare(`
    SELECT source_sha256 AS sourceSha256, source_language AS sourceLanguage,
           target_language AS targetLanguage
      FROM project WHERE id = ?
  `).get(projectId) as {
    sourceSha256: string; sourceLanguage: string | null; targetLanguage: string;
  } | undefined;
  if (row === undefined) throw new Error(`NO_SUCH_PROJECT: ${projectId}`);

  const glossaries = db.prepare(`
    SELECT g.name AS name, g.version AS version
      FROM project_glossary pg JOIN glossary g ON g.id = pg.glossary_id
     WHERE pg.project_id = ?
  `).all(projectId) as unknown as Array<{ name: string; version: number }>;

  return cacheKey({
    sourceSha256: row.sourceSha256,
    modelId,
    // The language the units were cut under, which is what the prompt names.
    // A project that never settled one has translated nothing yet, so the
    // placeholder only ever keys work that does not exist.
    sourceLanguage: row.sourceLanguage ?? "",
    targetLanguage: row.targetLanguage,
    glossaries: glossaries.map((glossary) => `${glossary.name}@${glossary.version}`),
  }, versions);
}
