import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { resolveHref, sha256, type PackageDoc, type ZipEntry } from "../../core/epub/index.ts";

export interface Workspace {
  root: string;
  /** The copy that will be translated. The original is never touched. */
  source: string;
  outputDir: string;
  exportDir: string;
}

/** Media types we are willing to write out as a cover. */
const IMAGES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"]);
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
  "image/webp": ".webp", "image/svg+xml": ".svg",
};

/**
 * Where a project keeps its artefacts — and nothing else.
 *
 * No state lives here: units, translations and events are in the database.
 * That split is what makes each half survive the other. If the workspace is
 * deleted, the project still appears and says its source is missing; if the
 * database is lost, the files are still readable books.
 */
export async function createWorkspace(base: string, projectId: string): Promise<Workspace> {
  const root = join(base, "projects", projectId);
  const workspace: Workspace = {
    root,
    source: join(root, "source.epub"),
    outputDir: join(root, "output"),
    exportDir: join(root, "export"),
  };

  await mkdir(workspace.outputDir, { recursive: true });
  await mkdir(workspace.exportDir, { recursive: true });
  return workspace;
}

/**
 * Copies the chosen EPUB into the workspace, and hashes the copy.
 *
 * The hash describes the file that will actually be translated. Hashing the
 * original instead would describe a file we do not control: the user may edit
 * or replace it, and the project would go on claiming a source it no longer
 * matches.
 */
export async function copySource(
  workspace: Workspace,
  epubPath: string,
): Promise<{ sha256: string; bytes: number }> {
  await copyFile(epubPath, workspace.source);
  const copied = await readFile(workspace.source);
  return { sha256: sha256(copied), bytes: copied.length };
}

/** The manifest item the book means as its cover, however it says so. */
function findCoverItem(pkg: PackageDoc): { href: string; mediaType: string } | null {
  const byProperty = pkg.manifest.find((item) =>
    (item.properties ?? "").split(/\s+/).includes("cover-image"));
  if (byProperty !== undefined) return byProperty;

  // EPUB 2 had no `cover-image` property and said it in the metadata instead.
  // Plenty of books in circulation still do, and refusing to look there would
  // leave a library of blank tiles.
  const named = /<meta[^>]*\bname=["']cover["'][^>]*\bcontent=["']([^"']+)["']/i.exec(pkg.source)
    ?? /<meta[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']cover["']/i.exec(pkg.source);
  if (named !== null) {
    const item = pkg.manifest.find((entry) => entry.id === named[1]);
    if (item !== undefined) return item;
  }

  return null;
}

/**
 * Writes the book's cover next to its source, and answers with the path.
 *
 * Null when there is none, or when the manifest points at an image the archive
 * does not carry. A missing cover is a placeholder in the library, not an
 * error: refusing to create a project over it would reject perfectly
 * translatable books.
 */
export async function extractCover(
  workspace: Workspace,
  entries: ZipEntry[],
  pkg: PackageDoc,
): Promise<string | null> {
  const item = findCoverItem(pkg);
  if (item === null || !IMAGES.has(item.mediaType)) return null;

  const { path } = resolveHref(pkg.path, item.href);
  const bytes = entries.find((entry) => entry.path === path)?.bytes;
  if (bytes === undefined) return null;

  const extension = EXTENSIONS[item.mediaType] ?? extname(path) ?? "";
  const cover = join(workspace.root, `cover${extension}`);
  await writeFile(cover, bytes);
  return cover;
}

/**
 * Removes the workspace, optionally saving the translated book first.
 *
 * Deleting the work that was paid for along with the project is the kind of
 * surprise nobody forgives, so the caller can name a path to keep the output
 * at. Deleting a workspace that is already gone is not an error: it is the
 * state the caller asked for.
 */
export async function deleteWorkspace(
  workspace: Workspace,
  options: { keepOutput?: string },
): Promise<void> {
  if (options.keepOutput !== undefined) {
    const produced = await readdir(workspace.outputDir).catch(() => [] as string[]);
    if (produced.length > 0) {
      await copyFile(join(workspace.outputDir, produced[0]), options.keepOutput);
    }
  }
  await rm(workspace.root, { recursive: true, force: true });
}
