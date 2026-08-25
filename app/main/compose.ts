import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertUtf8, buildSkeleton, checkInvariants, fillSkeleton, findPackagePath, hasOverlays,
  inspect, isWork, readEpub, removeOverlays, render, runEpubcheck, writeEpub, writeLanguage,
  writeRootLang,
  type EpubcheckResult, type InvariantResult, type TranslationUnit, type ZipEntry,
} from "../../core/epub/index.ts";
import type { ProjectStore } from "../../core/ports.ts";
import type { Workspace } from "./workspace.ts";

export interface ComposeResult {
  outputPath: string;
  invariants: InvariantResult[];
  epubcheck: EpubcheckResult;
  overlaysRemoved: { overlays: number; audio: number };
  status: "complete" | "incomplete" | "failed";
}

export interface ComposeInput {
  workspace: Workspace;
  store: ProjectStore;
  cacheKey: string;
  targetLanguage: string;
  title: string;
}

const DOCUMENT_EXTENSIONS = [".xhtml", ".html", ".htm"];

function isDocument(path: string): boolean {
  const lower = path.toLowerCase();
  return DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A title is prose; a file name cannot carry the parts of it that are not. */
function fileName(title: string, targetLanguage: string): string {
  const safe = title.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, "-");
  return `${safe === "" ? "book" : safe}.${targetLanguage}.epub`;
}

/**
 * Phase 9: from translated units to a book a reader can open.
 *
 * The output always goes to a new path in the workspace. When the gate rejects
 * the book, the source is intact and the rejected file stays inspectable:
 * deleting it would remove the only way to understand what went wrong.
 */
export async function composeEpub(input: ComposeInput): Promise<ComposeResult> {
  const { workspace, store, cacheKey, targetLanguage, title } = input;

  const archive = await readEpub(await readFile(workspace.source));
  const before = inspect(archive.entries);
  const opfPath = findPackagePath(archive.entries);

  const units = await store.units();
  const translations = await store.translations(cacheKey);

  const byDoc = new Map<string, TranslationUnit[]>();
  for (const unit of units) {
    const held = byDoc.get(unit.doc) ?? [];
    held.push(unit);
    byDoc.set(unit.doc, held);
  }

  // An attribute unit's translation patches the open tag of its owner's
  // placeholder; `render` applies only the patches its placeholders name.
  const translatedAttrs = new Map<string, string>();
  for (const unit of units) {
    if (unit.owner === undefined) continue;
    const held = translations.get(unit.id);
    if (held !== undefined) translatedAttrs.set(unit.id, held.text);
  }

  const skippedDocs: Array<{ path: string; reason: string }> = [];
  const discarded: string[] = [];
  let skeletonIdentity = true;

  let entries: ZipEntry[] = [];
  for (const entry of archive.entries) {
    if (!isDocument(entry.path)) {
      entries.push(entry);
      continue;
    }

    let source: string;
    try {
      source = assertUtf8(entry.bytes, entry.path);
    } catch {
      // Never guessed at: a document that will not decode is counted and left
      // byte for byte, for the gate to see and refuse.
      skippedDocs.push({ path: entry.path, reason: "unreadable" });
      entries.push(entry);
      continue;
    }

    const docUnits = byDoc.get(entry.path) ?? [];
    let composed = source;
    if (docUnits.length > 0) {
      const skeleton = buildSkeleton(source, docUnits);
      if (fillSkeleton(skeleton, docUnits, new Map()).text !== source) skeletonIdentity = false;

      // A unit without a translation re-emits its raw: that is what makes a
      // book that was never translated identical, and the gate an assertion.
      const rendered = new Map<string, string>();
      for (const unit of docUnits) {
        if (unit.owner !== undefined) continue;
        const held = translations.get(unit.id);
        if (held === undefined) continue;
        const markup = render(unit, held.text, translatedAttrs);
        // The engine refuses an empty answer at validation level 3; the
        // composer is the last checkpoint, and refuses it again. A paragraph
        // that vanishes is not a translation that went wrong, it is a book
        // missing a sentence, and no reader would forgive it quietly.
        if (markup === "" && unit.raw !== "") discarded.push(unit.id);
        rendered.set(unit.id, markup);
      }
      composed = fillSkeleton(skeleton, docUnits, rendered).text;
    }

    entries.push({ ...entry, bytes: Buffer.from(writeRootLang(composed, targetLanguage), "utf8") });
  }

  // The language goes in first; the overlay removal then cleans the result.
  const opfIndex = entries.findIndex((e) => e.path === opfPath);
  if (opfIndex === -1) throw new Error("COMPOSE_NO_PACKAGE");
  const withLanguage = writeLanguage(entries[opfIndex].bytes.toString("utf8"), targetLanguage, new Date());
  entries[opfIndex] = { ...entries[opfIndex], bytes: Buffer.from(withLanguage, "utf8") };

  let overlaysRemoved = { overlays: 0, audio: 0 };
  if (hasOverlays(entries)) {
    const removal = removeOverlays(entries, opfPath);
    entries = removal.entries;
    overlaysRemoved = removal.removed;
  }

  const outputPath = join(workspace.outputDir, fileName(title, targetLanguage));
  await writeFile(outputPath, await writeEpub(entries));

  // The gate inspects the file that was written, not the entries in memory:
  // what a reader would open is the only thing worth asserting about.
  const after = inspect((await readEpub(await readFile(outputPath))).entries);
  const invariants = checkInvariants({
    before,
    after,
    units,
    distrusted: units.filter((unit) => unit.state === "uncomposable").length,
    skippedDocs,
    targetLanguage,
    overlaysRemoved: overlaysRemoved.overlays > 0 || overlaysRemoved.audio > 0 ? overlaysRemoved : null,
    skeletonIdentity,
  });

  // The composer's own check, beside the book-level invariants: a stored
  // translation that renders to nothing means the markup never came back. The
  // id lives outside the I1–I22 table because the fault is in the run, not in
  // the book: the archive is fine, what it would say is a lie.
  invariants.push(translations.size === 0
    ? { id: "C1", name: "no discarded units", ok: true, details: ["no translations held"], skipped: true }
    : {
      id: "C1",
      name: "no discarded units",
      ok: discarded.length === 0,
      details: discarded.map((unitId) => `${unitId} rendered to nothing`),
    });

  const epubcheck = await runEpubcheck(outputPath);

  let status: ComposeResult["status"] = "complete";
  if (invariants.some((invariant) => !invariant.ok && !invariant.skipped)) {
    status = "failed";
  } else {
    const missing = units.filter((unit) => isWork(unit.state) && !translations.has(unit.id)).length;
    const fellBack = [...translations.values()].filter((held) => held.outcome === "fell-back").length;
    if (missing > 0 || fellBack > 0) status = "incomplete";
  }

  return { outputPath, invariants, epubcheck, overlaysRemoved, status };
}
