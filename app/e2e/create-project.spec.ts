import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { mainWindow, seedProvider } from "./support.ts";

/**
 * The one test that drives the real window.
 *
 * Everything under it has unit tests; what only this can show is that the
 * three processes agree — that the preload really loads, that the channels
 * really match, and that what the main process reads off a book reaches the
 * screen.
 */
async function launch(userData: string, epub: string) {
  await seedProvider(userData);
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env, BABELBOOK_USER_DATA: userData, BABELBOOK_EPUB_FOR_TEST: epub,
      // The seeded provider names an endpoint nothing answers on, which is
      // fine until a test presses "translate" — one below does, to prove the
      // button acts. The deterministic backend never reaches the network, so
      // the run ends quickly; `settled()` is what waits for it to, because
      // quickly is not the same as before the next line.
      BABELBOOK_FAKE_BACKEND: "1",
    },
  });
  return { app, window: await mainWindow(app) };
}

/** The settled states: from any of these the run is no longer holding the app. */
const SETTLED = ["waiting-terms", "waiting-code", "done", "incomplete", "failed", "paused"];

/**
 * Waits for the run to let go before the window is closed.
 *
 * Quitting with work in flight is a question, not an assumption
 * (`main.ts`'s `askQuit`): the application raises a native dialog and waits for
 * an answer that no test is there to give, and `app.close()` hangs until
 * Playwright gives up. The other specs that press this button already wait
 * this way; this one pressed and closed, and only got away with it for as long
 * as the run happened to finish inside the same tick.
 */
async function settled(window: Page): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const listed = await window.evaluate(() =>
      (window as unknown as { babelbook: { invoke(channel: string, payload: unknown): Promise<unknown> } })
        .babelbook.invoke("projects.list", {})) as Array<{ state: string }>;
    if (listed[0] !== undefined && SETTLED.includes(listed[0].state)) return;
    await window.waitForTimeout(50);
  }
  throw new Error("the run never let go of the application");
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

/**
 * A card is one target, not a word inside one.
 *
 * The title is still the link — it names the card for anything that reads
 * rather than points — but the cover, the counters and the space between them
 * open the book too. The buttons are the exception the sheet must not
 * swallow: they act where they are, on the shelf.
 */
test("the whole card opens the book, and its buttons still act where they are", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-e2e-"));
  const epub = await fixture(dir, "book.epub", {
    title: "Whole Card", language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
  });

  const { app, window } = await launch(dir, epub);

  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();
  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();
  await expect(window.getByTestId("library").getByText("Whole Card")).toBeVisible();

  // A point over the cover: no link and no text there, only the sheet the
  // title lays over the card. Named as a position because the sheet is what
  // takes the click, and a click aimed at the cover itself would be refused
  // for being intercepted — by the very thing under test.
  await window.locator("li.tile").click({ position: { x: 60, y: 60 } });
  await expect(window.getByTestId("project")).toBeVisible();

  // The way back is a button that closes the book and shows the shelf again.
  await window.getByTestId("project-back").click();
  await expect(window.getByTestId("library")).toBeVisible();

  // The button under the same sheet: it starts the run and stays on the shelf.
  await window.getByTestId("start").click();
  await expect(window.getByTestId("library")).toBeVisible();

  await settled(window);
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
