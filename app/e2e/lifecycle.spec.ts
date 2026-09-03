import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { mainWindow, seedProvider } from "./support.ts";

/**
 * Closing the window while a book is being translated.
 *
 * The invariant is one sentence and it holds on every desktop: **closing the
 * window during a run never leaves the person without one.** Where a tray is
 * really there the window hides and the icon brings it back; where there is
 * none the question is asked first, and Cancel keeps the window.
 *
 * It was broken twice. First the window hid into a tray that KDE had refused
 * to register, and the icon that would have brought it back did not exist.
 * Then, once the tray was let go of, the close ran to the end and the question
 * came afterwards from `before-quit` — so Cancel stopped the quitting of an
 * application whose only window was already destroyed.
 *
 * Both failures end in the same place, which is why the test asserts the end
 * and not the mechanism: a window, still there, after the person said no.
 */

interface Bridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

async function launch(userData: string, env: Record<string, string> = {}): Promise<{
  app: ElectronApplication; window: Page;
}> {
  await seedProvider(userData);
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      BABELBOOK_USER_DATA: userData,
      BABELBOOK_FAKE_BACKEND: "1",
      // Paced, so the run is genuinely in flight when the window is closed.
      BABELBOOK_FAKE_DELAY_MS: "150",
      ...env,
    },
  });
  return { app, window: await mainWindow(app) };
}

/** What the dialog will answer, before anything raises it. */
async function dialogAnswers(app: ElectronApplication, response: number): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox =
      async () => ({ response: chosen, checkboxChecked: false });
  }, response);
}

async function windowsOpen(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
}

async function runningState(window: Page): Promise<string> {
  const listed = await window.evaluate(() =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("projects.list", {}),
  ) as Array<{ state: string }>;
  return listed[0]?.state ?? "?";
}

test("closing during a run, then cancelling, leaves the window where it was", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-lifecycle-"));
  const epub = join(dir, "book.epub");
  await writeFile(epub, await buildEpub({
    title: "Still Here", language: "en",
    documents: [{
      path: "OEBPS/c1.xhtml",
      xhtml: Array.from({ length: 12 }, (_, at) => `<p>Paragraph number ${at}.</p>`).join(""),
    }],
  }));

  const { app, window } = await launch(dir, { BABELBOOK_EPUB_FOR_TEST: epub });

  try {
    await window.getByTestId("new-project").click();
    await window.getByTestId("choose-epub").click();
    await window.getByTestId("target-language").selectOption("it");
    await window.getByTestId("create").click();
    await expect(window.getByTestId("library").locator("li.tile").first()).toBeVisible();

    await window.evaluate(() =>
      (window as unknown as { babelbook: Bridge }).babelbook
        .invoke("settings.set", { autoAcceptTerms: true, autoAcceptExclusions: true, concurrency: 1 }));
    await window.getByTestId("library").locator("li.tile").first().getByTestId("start").click();

    const began = Date.now();
    while (await runningState(window) !== "running" && Date.now() - began < 20_000) {
      await window.waitForTimeout(50);
    }
    expect(await runningState(window)).toBe("running");

    // The person says no.
    await dialogAnswers(app, 1);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await window.waitForTimeout(1500);

    // Whatever the desktop decided about the tray, there is still a window.
    expect(await windowsOpen(app)).toBeGreaterThan(0);

    // And the application is still answering, which is the other half of
    // "still there": a window nobody can talk to would be no better.
    expect(["running", "paused", "waiting-terms", "done", "incomplete"])
      .toContain(await runningState(window));
  } finally {
    // Yes, this time, so the application really goes.
    await dialogAnswers(app, 0).catch(() => {});
    await app.close();
  }
});
