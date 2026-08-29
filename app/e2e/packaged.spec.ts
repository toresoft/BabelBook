import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { mainWindow } from "./support.ts";

/**
 * The package, opened.
 *
 * A build that finishes without errors and a package that runs are different
 * facts, and everything before this knows only the first. The failure this
 * exists to catch — the platform's `@node-rs/crc32` binding missing from the
 * archive — passes every build silently and shows up when someone opens a
 * book.
 *
 * It runs against whatever `BABELBOOK_PACKAGED` names: the unpacked directory
 * every target produces, or an AppImage, or `babelBook.exe`. With nothing
 * named there is nothing to check, so it skips rather than inventing a pass.
 */
const packaged = process.env["BABELBOOK_PACKAGED"];

test.skip(packaged === undefined, "BABELBOOK_PACKAGED names no package");

test("the package opens, migrates its database and reads a book", async () => {
  // Said before launching, and with the path it resolved. Playwright's own
  // answer to an executable that is not there is "Process failed to launch!",
  // which reads like a broken package and is usually a relative path resolved
  // from a directory nobody had in mind.
  const executable = resolve(packaged!);
  expect(existsSync(executable), `no package at ${executable} (from ${process.cwd()})`)
    .toBe(true);

  const dir = await mkdtemp(join(tmpdir(), "babelbook-packaged-"));
  const epub = join(dir, "book.epub");
  await writeFile(epub, await buildEpub({
    title: "Packaged", language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two</p><p>Three</p>" }],
  }));

  const app = await electron.launch({
    executablePath: executable,
    // An AppImage will not mount without FUSE on a bare runner; extracting is
    // slower and always works.
    args: packaged!.endsWith(".AppImage") ? ["--appimage-extract-and-run"] : [],
    env: { ...process.env, BABELBOOK_USER_DATA: dir, BABELBOOK_EPUB_FOR_TEST: epub },
  });

  // One: the window opens at all, so the preload loaded and the renderer was
  // found inside the archive.
  const window = await mainWindow(app);
  await expect(window.getByTestId("library")).toBeVisible({ timeout: 60_000 });

  // Two: a real EPUB is read. This is the assertion the test exists for —
  // reading the archive goes through `yauzl-promise` and its native binding.
  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();
  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();

  // Three: units were extracted and counted, so the database opened and its
  // migrations ran. Asked of the project rather than read off the tile: a
  // number matched in a sentence would also match the one in a date.
  const tile = window.getByTestId("library").locator("li.tile").first();
  await expect(tile).toBeVisible({ timeout: 60_000 });
  await expect(tile).toContainText("Packaged");

  const [project] = await window.evaluate(() =>
    (window as unknown as { babelbook: { invoke(c: string, p: unknown): Promise<unknown> } })
      .babelbook.invoke("projects.list", {})) as Array<{
        title: string; progress: { total: number };
      }>;
  expect(project).toMatchObject({ title: "Packaged" });
  expect(project!.progress.total).toBeGreaterThan(0);

  // Reading a book proves the native binding shipped; it says nothing about
  // the provider packages, which no phase before a run ever touches. This
  // asks the packaged main process to load one, which is the same act a
  // verification performs.
  const loaded = await app.evaluate(({ app }) => {
    // Playwright evaluates this callback through a VM script, which has no
    // dynamic-import hook. Anchor Node's package loader inside the packaged
    // app instead; resolution still happens from the ASAR's node_modules.
    const require = process.getBuiltinModule("node:module")
      .createRequire(`${app.getAppPath()}/package.json`);
    const sdk = require("ai") as typeof import("ai");
    const provider = require("@ai-sdk/openai-compatible") as
      typeof import("@ai-sdk/openai-compatible");
    return typeof sdk.generateText === "function"
      && Object.keys(provider).some((key) => key.startsWith("create"));
  });
  expect(loaded).toBe(true);

  await app.close();
});
