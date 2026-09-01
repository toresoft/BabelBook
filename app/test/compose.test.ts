import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BabelError } from "../../core/errors.ts";
import { buildEpub, OPF_PATH } from "../../core/test/corpus/build.ts";
import { extract, readEpub, sha256, writeEpub } from "../../core/epub/index.ts";
import { FakeStore } from "../../core/test/fake/store.ts";
import { copySource, createWorkspace, type Workspace } from "../main/workspace.ts";
import { composeEpub } from "../main/compose.ts";

/** Un workspace con un libro copiato e uno store che ne conosce le unità. */
async function prepared(spec: Parameters<typeof buildEpub>[0]) {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-compose-"));
  const epubPath = join(dir, "book.epub");
  await writeFile(epubPath, await buildEpub(spec));
  const workspace = await createWorkspace(dir, "p1");
  await copySource(workspace, epubPath);

  const epub = await readEpub(await readFile(workspace.source));
  const doc = spec.documents[0].path;
  const source = epub.get(doc)!.toString("utf8");
  const { units } = extract({ source, doc });
  return { dir, workspace, units, store: new FakeStore(units) };
}

const prose = { documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two</p>" }], language: "en" };

/** A workspace with the directories and nothing in them: no book was copied in. */
async function emptyWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-compose-"));
  return createWorkspace(dir, "p1");
}

/** A workspace with the corpus book copied in, ready to be composed. */
async function workspaceWithBook(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-compose-"));
  const epubPath = join(dir, "book.epub");
  await writeFile(epubPath, await buildEpub(prose));
  const workspace = await createWorkspace(dir, "p1");
  await copySource(workspace, epubPath);
  return workspace;
}

/**
 * A workspace whose book names a package document the archive does not carry:
 * the container still points at it, so the composer goes looking for it and
 * does not find it.
 */
async function workspaceWithoutPackage(): Promise<Workspace> {
  const workspace = await workspaceWithBook();
  const epub = await readEpub(await readFile(workspace.source));
  const withoutOpf = epub.entries.filter((entry) => entry.path !== OPF_PATH);
  await writeFile(workspace.source, await writeEpub(withoutOpf));
  return workspace;
}

/** The composition's inputs minus the workspace, which each test breaks its own way. */
function baseInput() {
  return { store: new FakeStore([]), cacheKey: "k1", targetLanguage: "it", title: "Book" };
}

describe("composeEpub", () => {
  it("writes to a new path and leaves the source untouched", async () => {
    const { workspace, store } = await prepared(prose);
    const before = sha256(await readFile(workspace.source));
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    expect(result.outputPath).not.toBe(workspace.source);
    expect(sha256(await readFile(workspace.source))).toBe(before);
  });

  it("changes only the language fields when no unit was translated", async () => {
    const { workspace, store } = await prepared(prose);
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    expect(result.invariants.filter((i) => !i.ok && !i.skipped)).toEqual([]);
    const out = await readEpub(await readFile(result.outputPath));
    expect(out.get("OEBPS/c1.xhtml")!.toString("utf8")).toContain("<p>One</p>");
  });

  it("removes the overlays and says how many", async () => {
    const { workspace, store } = await prepared({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">One</p>` }],
      overlays: [{ smilPath: "OEBPS/c1.smil", audioPath: "OEBPS/c1.mp3", forDocument: "OEBPS/c1.xhtml", duration: "0:00:05" }],
    });
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    expect(result.overlaysRemoved.overlays).toBe(1);
    const out = await readEpub(await readFile(result.outputPath));
    expect(out.order.some((p) => p.endsWith(".smil"))).toBe(false);
    expect(result.invariants.find((i) => i.id === "I22")?.ok).toBe(true);
  });

  it("keeps the rejected file when an invariant fails, so it can be inspected", async () => {
    const { workspace, store, units } = await prepared(prose);
    // una traduzione che butta via il markup: I17 deve scattare
    await store.putTranslation({
      unitId: units[0].id, text: "", cacheKey: "k1", attempts: 1, outcome: "translated",
    });
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    expect(result.status).toBe("failed");
    expect(existsSync(result.outputPath)).toBe(true);
  });

  it("says epubcheck did not run when the jar is absent, and never calls that a pass", async () => {
    const { workspace, store } = await prepared(prose);
    process.env.EPUBCHECK_JAR = "/nope/missing.jar";
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    delete process.env.EPUBCHECK_JAR;
    expect(result.epubcheck.ran).toBe(false);
    expect(result.status).not.toBe("failed");
  });
});

/**
 * Four causes used to arrive under one word. `COMPOSE_FAILED` was what the
 * reader saw whether the package was missing, the cache key was never written,
 * the disk was full, or the workspace had moved — and none of those four is
 * fixed the way the others are.
 */
describe("a composition that cannot finish", () => {
  it("says the package is missing, and that the book is the problem", async () => {
    const workspace = await workspaceWithoutPackage();
    await expect(composeEpub({ ...baseInput(), workspace }))
      .rejects.toMatchObject({ code: "COMPOSE_NO_PACKAGE", fault: "input" });
  });

  it("says the source is not where it was", async () => {
    const workspace = { ...(await emptyWorkspace()), source: "/nowhere/source.epub" };
    const thrown = await composeEpub({ ...baseInput(), workspace }).catch((error) => error);
    expect(thrown).toBeInstanceOf(BabelError);
    expect(thrown.code).toBe("SOURCE_MISSING");
    expect(thrown.fault).toBe("input");
  });

  // The brief's `/proc/nowhere` cannot produce a config-fault errno on Linux
  // (the write fails ENOENT, which is an input fault); a directory the machine
  // refuses to write is the same class of cause, produced for real.
  it("says the output path is not writable, and that somebody has to act", async () => {
    const workspace = await workspaceWithBook();
    try {
      chmodSync(workspace.outputDir, 0o500);
      const thrown = await composeEpub({ ...baseInput(), workspace }).catch((error) => error);
      expect(thrown.fault).toBe("config");
    } finally {
      chmodSync(workspace.outputDir, 0o755);
    }
  });
});
