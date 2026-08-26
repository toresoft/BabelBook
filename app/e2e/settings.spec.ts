import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
// Node runs this file as plain ESM, which requires the attribute; the
// renderer's bundler does not, which is why the two differ.
import en from "../locales/en.json" with { type: "json" };
import it from "../locales/it.json" with { type: "json" };

/**
 * The settings, through the real window.
 *
 * The file dialogs are deliberately not driven here: doing so would need a new
 * environment hook in production code, and the unit tests already prove the
 * main process reads and writes those files. What only this can show is that
 * the four sections load, that each one reaches its own channels, and that a
 * setting survives being written.
 */
interface Bridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

async function launch(userData: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, BABELBOOK_USER_DATA: userData },
  });
  return { app, window: await app.firstWindow() };
}

const label = (catalogue: unknown, path: string): string =>
  path.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], catalogue) as string;

test("the four sections, and a setting that survives", async () => {
  const userData = await mkdtemp(join(tmpdir(), "babelbook-settings-"));
  const { app, window } = await launch(userData);

  await window.getByTestId("settings").click();
  await expect(window.getByTestId("providers")).toBeVisible();

  // A glossary written by hand, with no dialog involved.
  await window.getByTestId("section-glossaries").click();
  await expect(window.getByTestId("glossaries-empty")).toBeVisible();
  await window.getByTestId("new-glossary").click();
  await window.getByTestId("glossary-name").fill("fantasy");
  await window.getByTestId("glossary-description").fill("Epic fantasy with invented names");
  await window.getByTestId("add-gterm").click();
  await window.getByTestId("gterm-source-0").fill("Rivendell");
  await window.getByTestId("save-glossary").click();

  const row = window.getByTestId("glossaries").locator("li.glossary").first();
  await expect(row).toContainText("fantasy");
  await expect(row).toContainText(label(it, "glossaries.terms").replace("{{count}}", "1"));

  // A gate skipped is a decision, and it has to persist.
  await window.getByTestId("section-translation").click();
  await window.getByTestId("auto-terms").check();
  await expect.poll(async () => window.evaluate(() =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("settings.get", undefined)))
    .toMatchObject({ autoAcceptTerms: true });

  // The interface language changes now, not at the next start.
  await window.getByTestId("section-application").click();
  await window.getByTestId("ui-language").selectOption("en");
  await expect(window.getByTestId("section-glossaries"))
    .toHaveText(label(en, "settings.sections.glossaries"));

  await app.close();

  // And it is still English when the window comes back.
  const again = await launch(userData);
  await again.window.getByTestId("settings").click();
  await expect(again.window.getByTestId("section-glossaries"))
    .toHaveText(label(en, "settings.sections.glossaries"));
  await again.app.close();
});
