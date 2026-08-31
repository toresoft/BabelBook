import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import {
  archiveCodeSurfaces, assertUtf8, detectLayout, extract, hasOverlays,
  readEpub, readPackage, resolveHref,
  type TranslationUnit,
} from "../../../core/epub/index.ts";
import type { CreatedProject, CreateProjectRequest as CreateInput } from "../../shared/dto.ts";
import { enterState, leaveState } from "../run/states.ts";
import { assertProviderChosen } from "./provider.ts";
import { createWorkspace, copySource, deleteWorkspace, extractCover, type Workspace } from "../workspace.ts";

export type { CreatedProject, CreateProjectRequest as CreateInput } from "../../shared/dto.ts";

/**
 * A file we recognise and do not handle.
 *
 * Naming the format is the whole point: "this is not an EPUB" tells the user
 * nothing they can act on, while "this is a MOBI, babelBook only handles EPUB"
 * tells them to convert it.
 */
export class UnsupportedFormatError extends Error {
  code = "UNSUPPORTED_FORMAT";
  format: string;

  constructor(format: string) {
    super(`UNSUPPORTED_FORMAT: ${format}`);
    this.name = "UnsupportedFormatError";
    this.format = format;
  }
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** What the first bytes say the file is. */
function identify(head: Buffer): "epub" | string {
  const ascii = head.subarray(0, 64).toString("latin1");

  if (ascii.startsWith("BOOKMOBI") || head.subarray(60, 68).toString("latin1") === "BOOKMOBI") {
    return "MOBI";
  }
  if (ascii.startsWith("TPZ")) return "Topaz";
  if (ascii.startsWith("%PDF")) return "PDF";
  if (ascii.startsWith("{\\rtf")) return "RTF";

  if (head.subarray(0, 4).equals(ZIP)) {
    // A zip is an EPUB only if it says so: OCF requires an uncompressed
    // `mimetype` entry first. Anything else that happens to be a zip — an
    // office document, a folder someone compressed — is not this tool's job.
    return ascii.includes("mimetypeapplication/epub+zip") ? "epub" : "ZIP";
  }
  return "unknown";
}

const WORD = /\p{L}[\p{L}\p{M}'’-]*/gu;

function countWords(units: TranslationUnit[]): number {
  return units.reduce((total, unit) => total + (unit.source.match(WORD)?.length ?? 0), 0);
}

/** A tag we can act on. `und` and `mul` are well-formed and say nothing. */
function usableLanguage(tag: string): string | null {
  const primary = tag.trim().split("-")[0]?.toLowerCase() ?? "";
  if (!/^[a-z]{2,3}$/.test(primary) || primary === "und" || primary === "mul") return null;
  return primary;
}

/**
 * A book, read into a project — locally, and without spending anything.
 *
 * Every step here is deterministic: the archive, the package, the layout, the
 * units and their states all come from the file itself. That is deliberate.
 * The counts it produces are what the interface shows the user *before* asking
 * them to pay for a translation — nothing here calls a model. What it does
 * require is that a model has been *chosen*: a project with no provider is a
 * book nobody can translate, and the library refuses to offer one.
 *
 * Either all of it lands or none of it does. A half-ingested project is worse
 * than no project: the library shows it, and it does not work.
 */
export async function createProject(
  db: DatabaseSync,
  base: string,
  input: CreateInput,
): Promise<CreatedProject> {
  // Before the file is read and long before the workspace exists: a refusal
  // that had already copied an EPUB would leave a directory nobody owns.
  assertProviderChosen(db, input.providerId, input.modelId);

  const analysisStartedAt = new Date().toISOString();
  const head = Buffer.alloc(1024);
  const whole = await readFile(input.epubPath);
  whole.copy(head, 0, 0, Math.min(head.length, whole.length));

  const format = identify(head);
  if (format !== "epub") throw new UnsupportedFormatError(format);

  const projectId = randomUUID();
  let workspace: Workspace | null = null;

  try {
    workspace = await createWorkspace(base, projectId);
    const { sha256 } = await copySource(workspace, input.epubPath);

    const epub = await readEpub(await readFile(workspace.source));
    const pkg = readPackage(epub.entries);
    const layout = detectLayout(pkg);
    const overlays = hasOverlays(epub.entries);
    const surfaces = archiveCodeSurfaces(epub.entries);
    const coverPath = await extractCover(workspace, epub.entries, pkg);

    const declaredLanguage = usableLanguage(pkg.language);
    const sourceLanguage = input.sourceLanguage ?? declaredLanguage;

    const documents: Array<{ id: string; path: string; order: number; units: TranslationUnit[] }> = [];
    const byState: Record<string, number> = {};
    let skipped = 0;

    const spineOrder = new Map(pkg.spine.map((item, at) => [item.idref, at]));
    const inSpine = pkg.manifest
      .filter((item) => item.mediaType === "application/xhtml+xml")
      .sort((a, b) => (spineOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER)
        - (spineOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));

    inSpine.forEach((item, order) => {
      const { path } = resolveHref(pkg.path, item.href);
      const bytes = epub.get(path);
      if (bytes === undefined) {
        skipped++;
        return;
      }

      let source: string;
      try {
        source = assertUtf8(bytes, path);
      } catch {
        // Never guessed at. A document in an unknown encoding is counted and
        // left alone; inventing an encoding would corrupt a chapter quietly.
        skipped++;
        return;
      }

      const nav = (item.properties ?? "").split(/\s+/).includes("nav");
      const { units } = extract({ source, doc: path, codeSurfaces: surfaces, nav });
      for (const unit of units) byState[unit.state] = (byState[unit.state] ?? 0) + 1;

      documents.push({ id: randomUUID(), path, order, units });
    });

    const allUnits = documents.flatMap((document) => document.units);
    const work = allUnits.filter((unit) => unit.state === "translate" || unit.state === "maybe-code");

    db.exec("BEGIN");
    try {
      db.prepare(`
        INSERT INTO project (
          id, filename, title, author, workspace_path, source_sha256, created_at,
          description, source_language, target_language, provider_id, model_id,
          state, layout, has_overlays, cover_file
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        projectId, input.epubPath.split("/").pop() ?? "book.epub", pkg.title, pkg.author ?? null,
        workspace.root, sha256, new Date().toISOString(), input.description ?? null,
        sourceLanguage, input.targetLanguage, input.providerId, input.modelId,
        sourceLanguage === null ? "needs-language" : "ready", layout.book, overlays ? 1 : 0,
        coverPath === null ? null : coverPath.split("/").pop()!,
      );

      const insertDocument = db.prepare(
        "INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES (?,?,?,?)",
      );
      const insertUnit = db.prepare(`
        INSERT INTO unit (
          id, project_id, document_id, ordinal, unit_id, kind,
          range_start, range_end, state, source_text, raw_text, placeholders, reason, owner_unit_id,
          element, class_name
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      for (const document of documents) {
        insertDocument.run(document.id, projectId, document.path, document.order);
        for (const unit of document.units) {
          insertUnit.run(
            randomUUID(), projectId, document.id, unit.ordinal, unit.id, unit.kind,
            unit.range[0], unit.range[1], unit.state, unit.source, unit.raw,
            unit.placeholders === undefined ? null : JSON.stringify(unit.placeholders),
            unit.reason ?? null, unit.owner ?? null,
            unit.element ?? null, unit.className ?? null,
          );
        }
      }

      // The analysis is a phase like the others; it just happens before any
      // run exists, and the units are what it produced.
      enterState(db, {
        projectId, kind: "phase", name: "analyze", enteredAt: analysisStartedAt,
      });
      leaveState(db, {
        projectId, kind: "phase", outcome: "done",
        info: { documents: documents.length, units: allUnits.length, skipped },
      });
      enterState(db, {
        projectId, kind: "project",
        name: sourceLanguage === null ? "needs-language" : "ready",
      });

      if (skipped > 0) {
        db.prepare(`
          INSERT INTO run (id, project_id, phase, started_at) VALUES (?,?,'ingest',?)
        `).run(projectId, projectId, new Date().toISOString());
        db.prepare(`
          INSERT INTO run_event (id, run_id, at, code, severity, payload_json)
          VALUES (?,?,?,'document-skipped','degradation',?)
        `).run(randomUUID(), projectId, new Date().toISOString(), JSON.stringify({ documents: skipped }));
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return {
      id: projectId,
      title: pkg.title,
      ...(pkg.author === undefined ? {} : { author: pkg.author }),
      coverPath,
      declaredLanguage,
      documents: documents.length,
      units: { total: allUnits.length, work: work.length, byState },
      words: countWords(work),
      layout: {
        book: layout.book,
        prePaginated: layout.prePaginated,
        documents: Object.keys(layout.byDocument).length,
      },
      hasOverlays: overlays,
    };
  } catch (error) {
    if (workspace !== null) await deleteWorkspace(workspace, {});
    throw error;
  }
}
