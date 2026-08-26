import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { mainWindow } from "./support.ts";

/**
 * The one test that drives the real window.
 *
 * Everything under it has unit tests; what only this can show is that the
 * three processes agree — that the preload really loads, that the channels
 * really match, and that what the main process reads off a book reaches the
 * screen.
 */
async function launch(userData: string, epub: string) {
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, BABELBOOK_USER_DATA: userData, BABELBOOK_EPUB_FOR_TEST: epub },
  });
  return { app, window: await mainWindow(app) };
}

async function fixture(dir: string, name: string, spec: Parameters<typeof buildEpub>[0]) {
  const path = join(dir, name);
  await writeFile(path, await buildEpub(spec));
  return path;
}

test("creates a project from an EPUB and shows it in the library", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-e2e-"));
  const epub = await fixture(dir, "book.epub", {
    title: "End To End", language: "en",
    documents: [
      { path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two</p>" },
      { path: "OEBPS/c2.xhtml", xhtml: "<p>Three</p>" },
    ],
  });

  const { app, window } = await launch(dir, epub);

  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();

  await expect(window.getByTestId("preview-title")).toHaveText("End To End");
  await expect(window.getByTestId("estimate")).toBeVisible();

  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();

  await expect(window.getByTestId("library").getByText("End To End")).toBeVisible();
  await app.close();
});

test("warns about a fixed-layout book before anything is spent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-e2e-"));
  const epub = await fixture(dir, "comic.epub", {
    title: "The Plates", language: "en",
    documents: [{ path: "OEBPS/p1.xhtml", xhtml: "<p>Plate</p>", layout: "pre-paginated" }],
  });

  const { app, window } = await launch(dir, epub);

  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();

  await expect(window.getByTestId("layout-warning")).toBeVisible();
  await app.close();
});

test("says what a MOBI is instead of refusing it namelessly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-e2e-"));
  const notEpub = join(dir, "book.mobi");
  await writeFile(notEpub, "BOOKMOBI and then some rubbish");

  const { app, window } = await launch(dir, notEpub);

  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();

  await expect(window.getByTestId("failure")).toContainText("MOBI");
  await app.close();
});
