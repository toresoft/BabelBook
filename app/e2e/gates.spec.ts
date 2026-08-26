import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";

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
  return { app, window: await app.firstWindow() };
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

  // Both gates are on by default, so the run stops and asks.
  await until(window, "waiting-terms");
  await expect(window.getByTestId("terms")).toBeVisible();
  await window.getByTestId("approve-gate").click();

  await until(window, "waiting-code");
  await expect(window.getByTestId("exclusions")).toBeVisible();
  await window.getByTestId("approve-exclusions").click();

  // And the decisions are what let it finish.
  await until(window, "done");
  await window.getByTestId("tab-report").click();
  await expect(window.getByTestId("status-complete")).toBeVisible();

  await app.close();
});
