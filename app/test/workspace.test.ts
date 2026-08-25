import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { readEpub, readPackage, sha256 } from "../../core/epub/index.ts";
import { copySource, createWorkspace, deleteWorkspace, extractCover } from "../main/workspace.ts";

const base = () => mkdtemp(join(tmpdir(), "babelbook-ws-"));

async function epubAt(dir: string, spec: Parameters<typeof buildEpub>[0]) {
  const path = join(dir, "book.epub");
  await writeFile(path, await buildEpub(spec));
  return path;
}

const prose = { documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] };
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

describe("createWorkspace", () => {
  it("creates the folders a project needs", async () => {
    const workspace = await createWorkspace(await base(), "p1");

    expect(existsSync(workspace.root)).toBe(true);
    expect(existsSync(workspace.outputDir)).toBe(true);
  });

  it("gives each project its own folder", async () => {
    const dir = await base();
    const one = await createWorkspace(dir, "p1");
    const two = await createWorkspace(dir, "p2");

    expect(one.root).not.toBe(two.root);
  });
});

describe("copySource", () => {
  it("copies the source and hashes what it copied, not what it read", async () => {
    const dir = await base();
    const epub = await epubAt(dir, prose);
    const workspace = await createWorkspace(dir, "p1");

    const { sha256: hash, bytes } = await copySource(workspace, epub);
    const copied = await readFile(workspace.source);

    expect(copied).toEqual(await readFile(epub));
    expect(hash).toBe(sha256(copied));
    expect(bytes).toBe(copied.length);
  });

  it("leaves the original where it was", async () => {
    const dir = await base();
    const epub = await epubAt(dir, prose);
    await copySource(await createWorkspace(dir, "p1"), epub);

    expect(existsSync(epub)).toBe(true);
  });
});

describe("extractCover", () => {
  const withCover = async (dir: string, manifestExtra: string, metadataExtra = "") => {
    const bytes = await buildEpub({
      ...prose,
      extra: [{ path: "OEBPS/cover.png", bytes: PNG }],
      manifestExtra, metadataExtra,
    });
    const epub = await readEpub(bytes);
    return { epub, workspace: await createWorkspace(dir, "p1") };
  };

  it("takes the image the manifest marks as the cover", async () => {
    const { epub, workspace } = await withCover(await base(),
      `<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>`);

    const cover = await extractCover(workspace, epub.entries, readPackage(epub.entries));
    expect(cover).not.toBeNull();
    expect(existsSync(cover!)).toBe(true);
    expect(await readFile(cover!)).toEqual(PNG);
  });

  it("falls back to the EPUB 2 meta when there is no cover-image property", async () => {
    const { epub, workspace } = await withCover(await base(),
      `<item id="the-cover" href="cover.png" media-type="image/png"/>`,
      `<meta name="cover" content="the-cover"/>`);

    expect(await extractCover(workspace, epub.entries, readPackage(epub.entries))).not.toBeNull();
  });

  it("returns null instead of failing when the book has no cover", async () => {
    const epub = await readEpub(await buildEpub(prose));
    const workspace = await createWorkspace(await base(), "p1");

    expect(await extractCover(workspace, epub.entries, readPackage(epub.entries))).toBeNull();
  });

  it("keeps the image's own extension, so it can be served as what it is", async () => {
    const { epub, workspace } = await withCover(await base(),
      `<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>`);

    expect(await extractCover(workspace, epub.entries, readPackage(epub.entries)))
      .toMatch(/\.png$/);
  });

  it("survives a manifest that points at an image the archive does not have", async () => {
    const bytes = await buildEpub({
      ...prose,
      manifestExtra: `<item id="cover-image" href="missing.png" media-type="image/png" properties="cover-image"/>`,
    });
    const epub = await readEpub(bytes);
    const workspace = await createWorkspace(await base(), "p1");

    expect(await extractCover(workspace, epub.entries, readPackage(epub.entries))).toBeNull();
  });
});

describe("deleteWorkspace", () => {
  it("deletes the workspace but can keep the translated book", async () => {
    const dir = await base();
    const workspace = await createWorkspace(dir, "p1");
    await writeFile(join(workspace.outputDir, "book.it.epub"), "translated");
    const kept = join(dir, "kept.epub");

    await deleteWorkspace(workspace, { keepOutput: kept });

    expect(existsSync(workspace.root)).toBe(false);
    expect(await readFile(kept, "utf8")).toBe("translated");
  });

  it("deletes everything when nothing is to be kept", async () => {
    const dir = await base();
    const workspace = await createWorkspace(dir, "p1");
    await writeFile(join(workspace.outputDir, "book.it.epub"), "translated");

    await deleteWorkspace(workspace, {});
    expect(existsSync(workspace.root)).toBe(false);
  });

  it("does not fail on a workspace that is already gone", async () => {
    const workspace = await createWorkspace(await base(), "p1");
    await deleteWorkspace(workspace, {});

    await expect(deleteWorkspace(workspace, {})).resolves.toBeUndefined();
  });
});
