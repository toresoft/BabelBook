import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

/**
 * Adding a provider through the interface, which is the only thing that makes
 * the encrypted store reachable by a user.
 *
 * What this proves is the wiring: the preload exposes the channels, the main
 * process owns the keyring, the list comes back and says "key set" without
 * ever carrying the key. What it deliberately does not prove is the
 * encryption itself — a spawned Electron here cannot reach the desktop
 * keyring and falls back to `basic_text`, so the test asks for plaintext
 * explicitly rather than pretending. That the bytes are sealed is the unit
 * suite's claim, with a fake keyring that really hides them.
 */
async function launch(userData: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, BABELBOOK_USER_DATA: userData },
  });
  // From the test, never from production code: an environment variable that
  // turned off encryption would be one typo away from doing it for real.
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true));
  return app;
}

test("adds a provider from a preset and never hands the key back", async () => {
  const userData = await mkdtemp(join(tmpdir(), "babelbook-providers-"));
  const app = await launch(userData);
  const window = await app.firstWindow();

  await window.getByTestId("settings").click();
  await expect(window.getByTestId("providers-empty")).toBeVisible();

  await window.getByTestId("preset-anthropic").click();
  await expect(window.getByTestId("provider-name")).toHaveValue("Anthropic");
  await window.getByTestId("provider-api-key").fill("sk-typed-by-the-user");
  await window.getByTestId("save-provider").click();

  const row = window.getByTestId("providers").locator("li.provider").first();
  await expect(row).toContainText("Anthropic");
  await expect(row.getByTestId("key-set")).toBeVisible();

  // The reply that built this screen is the one the renderer actually got: if
  // the key rode along in it, it would be here.
  const listed = await window.evaluate(() =>
    (window as unknown as { babelbook: { invoke(c: string, p: unknown): Promise<unknown> } })
      .babelbook.invoke("providers.list", undefined));
  expect(JSON.stringify(listed)).not.toContain("sk-typed-by-the-user");

  await app.close();

  // And it survives a restart, because a key that has to be retyped at every
  // launch is a key nobody would keep here.
  const again = await launch(userData);
  const reopened = await again.firstWindow();
  await reopened.getByTestId("settings").click();
  await expect(reopened.getByTestId("providers").locator("li.provider").first()
    .getByTestId("key-set")).toBeVisible();
  await again.close();
});

test("renaming a provider does not log the user out of it", async () => {
  const userData = await mkdtemp(join(tmpdir(), "babelbook-providers-edit-"));
  const app = await launch(userData);
  const window = await app.firstWindow();

  await window.getByTestId("settings").click();
  await window.getByTestId("preset-openai").click();
  await window.getByTestId("provider-api-key").fill("sk-still-there");
  await window.getByTestId("save-provider").click();

  const row = window.getByTestId("providers").locator("li.provider").first();
  await expect(row.getByTestId("key-set")).toBeVisible();

  // The form cannot prefill a key it is not allowed to read, so an edit that
  // leaves the field empty has to keep the stored one.
  await row.getByRole("button", { name: "Modifica" }).click();
  await window.getByTestId("provider-name").fill("OpenAI Europe");
  await expect(window.getByTestId("provider-api-key")).toHaveValue("");
  await window.getByTestId("save-provider").click();

  await expect(row).toContainText("OpenAI Europe");
  await expect(row.getByTestId("key-set")).toBeVisible();
  await app.close();
});
