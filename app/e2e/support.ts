import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";

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

/**
 * One provider and one model, written into the database the application is
 * about to open.
 *
 * A project cannot be created without a provider any more. Driving the
 * provider screen in every spec would test that screen six times and the
 * thing under test once — and the specs that mean to test it already do.
 *
 * The rows go in through the application's own migrations, against the path
 * the application itself will open, so a schema change breaks this too. That
 * is the point: a fixture that outlives the schema is a fixture that lies.
 *
 * Called more than once on the same profile it does nothing the second time.
 * A spec that closes the window and opens it again — the pause-and-resume one
 * does exactly that — must not be made to fail by its own fixture.
 */
export async function seedProvider(userData: string): Promise<void> {
  await mkdir(userData, { recursive: true });
  const db = openDatabase(join(userData, "babelbook.db"));
  migrate(db, loadMigrations(join(import.meta.dirname, "../main/db/migrations")));
  db.prepare(`
    INSERT INTO provider (id, name, route, base_url, headers, options)
    VALUES ('e2e-provider', 'End To End', 'openai-compatible', 'http://127.0.0.1:1', '{}', '{}')
    ON CONFLICT (id) DO NOTHING
  `).run();
  db.prepare(`
    INSERT INTO provider_model (id, provider_id, model_id, display_name,
                                context_window, price_in, price_out)
    VALUES ('e2e-model', 'e2e-provider', 'e2e-model-1', 'E2E Model', 128000, 1, 5)
    ON CONFLICT (id) DO NOTHING
  `).run();
  db.close();
}
