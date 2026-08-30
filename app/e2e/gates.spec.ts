import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
// Node runs this file as plain ESM, which requires the attribute.
import it from "../locales/it.json" with { type: "json" };
import { mainWindow } from "./support.ts";

const label = (catalogue: unknown, path: string): string =>
  path.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], catalogue) as string;

/**
 * The two gates, opened and closed by hand.
 *
 * Everything else has been driven with auto-acceptance on, which walks past
 * exactly the part plan 5 exists for. This is the only test where a person
 * decides: the run stops, the screen shows what it is asking, the decision is
 * stored, and the machine moves because of it.
 */
interface Bridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

async function launch(userData: string, epub: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      BABELBOOK_USER_DATA: userData,
      BABELBOOK_FAKE_BACKEND: "1",
      BABELBOOK_EPUB_FOR_TEST: epub,
    },
  });
  return { app, window: await mainWindow(app) };
}

async function projects(window: Page): Promise<Array<{ id: string; state: string }>> {
  return window.evaluate(() =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("projects.list", {}));
}

async function until(window: Page, wanted: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const listed = await projects(window);
    if (listed[0]?.state === wanted) return;
    await window.waitForTimeout(50);
  }
  const seen = (await projects(window))[0]?.state;
  throw new Error(`the project never reached ${wanted}; it is ${seen}`);
}

test("a person walks the book through both gates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-gates-"));
  const epub = join(dir, "book.epub");
  await writeFile(epub, await buildEpub({
    title: "Gated", language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two</p><pre>npm install foo</pre>" }],
  }));

  const { app, window } = await launch(dir, epub);
  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();
  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();

  // Into the book's own screen, from the library.
  const tile = window.getByTestId("library").locator("li.tile").first();
  await expect(tile).toBeVisible();
  await tile.locator("a.tile__title").click();
  await expect(window.getByTestId("project")).toBeVisible();
  await expect(window.getByTestId("tab-overview")).toBeVisible();

  // The button exists because the machine says START is allowed.
  await window.getByTestId("project-start").click();

  // Both gates are on by default, so the run stops and asks. A gate that
  // shows an empty list has not asked anything, so the candidates are what
  // this assertion is about.
  await until(window, "waiting-terms");
  await expect(window.getByTestId("terms")).toBeVisible();
  await expect(window.getByTestId("terms").locator(".table__row").first()).toBeVisible();

  // Approving is what the gate is for. Pressing "continue" without deciding
  // leaves every candidate pending, and pending terminology is dropped: the
  // run would proceed having been asked a question it never answered.
  await window.getByTestId("approve-all").click();
  await expect(window.getByTestId("terms").locator(".table__row").first())
    .toContainText(label(it, "terms.approval.approved"));
  await window.getByTestId("approve-gate").click();

  await until(window, "waiting-code");
  await expect(window.getByTestId("exclusions")).toBeVisible();
  await window.getByTestId("approve-exclusions").click();

  // And the decisions are what let it finish.
  await until(window, "done");
  await window.getByTestId("tab-report").click();
  await expect(window.getByTestId("status-complete")).toBeVisible();

  // The invariants are reported, and a check that did not run is not a pass.
  await expect(window.getByTestId("no-invariants")).toHaveCount(0);
  await expect(window.getByTestId("epubcheck-not-run")).toBeVisible();
  await expect(window.getByTestId("epubcheck-clean")).toHaveCount(0);

  await app.close();

  // The book is on disk, not merely declared.
  const projectsDir = join(dir, "projects");
  const [projectId] = await readdir(projectsDir);
  expect((await readdir(join(projectsDir, projectId!, "output"))).some((name) => name.endsWith(".it.epub")))
    .toBe(true);
});

test("editing a term after the run says what it would undo, before undoing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-invalidate-"));
  const epub = join(dir, "book.epub");
  await writeFile(epub, await buildEpub({
    title: "Rivendell Road", language: "en",
    // The same name opens both paragraphs: whichever passage the extraction
    // samples, it proposes this term, and it is in exactly two units. A
    // fixture where the word appeared once would make the expected count
    // depend on which sample the fake happened to see.
    documents: [{
      path: "OEBPS/c1.xhtml",
      xhtml: "<p>Rivendell was quiet that evening</p><p>Rivendell again, at dawn</p>",
    }],
  }));

  const { app, window } = await launch(dir, epub);
  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();
  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();

  const tile = window.getByTestId("library").locator("li.tile").first();
  await expect(tile).toBeVisible();
  await tile.locator("a.tile__title").click();
  await window.getByTestId("project-start").click();

  // Straight through both gates: this test is about what happens afterwards.
  await until(window, "waiting-terms");
  await window.getByTestId("approve-all").click();
  await window.getByTestId("approve-gate").click();
  await until(window, "waiting-code");
  await window.getByTestId("approve-exclusions").click();
  await until(window, "done");

  // Now the terms are approved and the units are translated, so changing a
  // rendering costs something — and the screen has to say how much before it
  // spends it. The prototype threw the whole session away at this point and
  // the price arrived on the invoice.
  await window.getByTestId("tab-terms").click();
  // Named, not taken by position: the term that appears in both paragraphs is
  // the one whose count this test is about, and which row it lands in is an
  // ordering detail that would make the assertion lie if it changed.
  const rivendell = window.getByTestId("terms").locator("li.term")
    .filter({ has: window.locator("strong.term__source", { hasText: /^Rivendell$/ }) })
    .first();
  await expect(rivendell).toBeVisible();
  await expect(rivendell).toContainText(label(it, "terms.occurrences").replace("{{count}}", "2"));
  await rivendell.locator("select").first().selectOption("must");

  const warning = window.getByTestId("invalidation");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("2");

  await app.close();
});
