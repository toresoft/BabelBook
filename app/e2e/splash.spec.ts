import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { mainWindow } from "./support.ts";

/**
 * The splash, and the thing that matters more: that it goes away.
 *
 * A frameless window that outlives the start would sit over the application
 * with no frame, no title bar and no way to close it — worse than the second
 * of nothing it was added to cover.
 */
test("shows something at once, and only the window once it is ready", async () => {
  const userData = await mkdtemp(join(tmpdir(), "babelbook-splash-"));
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, BABELBOOK_USER_DATA: userData },
  });

  // The splash is raised before the database, the catalogues and the window,
  // so at some point in the start there is a window that is not the main one.
  const seen = await app.evaluate(async ({ BrowserWindow }) => {
    const titles = new Set<string>();
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const window of BrowserWindow.getAllWindows()) {
        titles.add(`${window.isResizable()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return [...titles];
  });
  // A non-resizable window is the splash; the main window is resizable.
  expect(seen).toContain("false");

  await mainWindow(app);
  await expect.poll(async () => app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      resizable: window.isResizable(), visible: window.isVisible(),
    })))).toEqual([{ resizable: true, visible: true }]);

  await app.close();
});
