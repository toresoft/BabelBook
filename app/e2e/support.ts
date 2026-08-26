import type { ElectronApplication, Page } from "@playwright/test";

/**
 * The application's window, which is no longer the first one opened.
 *
 * The splash is raised before anything slow happens, so it wins the race that
 * `firstWindow()` resolves. Asking for the first window therefore hands back a
 * frameless box with no bridge on it, and every assertion that follows fails
 * for a reason that has nothing to do with what was being tested.
 *
 * The two are told apart by what they load: the splash is a `data:` URL, the
 * application a registered `app://` origin — or the dev server, when one is
 * running.
 */
export async function mainWindow(app: ElectronApplication): Promise<Page> {
  const isApplication = (page: Page): boolean => !page.url().startsWith("data:");

  for (const open of app.windows()) {
    if (isApplication(open)) return open;
  }
  return app.waitForEvent("window", { predicate: isApplication });
}
