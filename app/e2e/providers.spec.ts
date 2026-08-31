import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mainWindow } from "./support.ts";

/**
 * Connecting a provider through the interface, which is the only thing that
 * makes the encrypted store reachable by a user.
 *
 * The catalogue is a file this test writes and the main process serves, and
 * the endpoints are HTTP servers this test runs: nothing here reaches the
 * network or needs a real provider. What is proved is the wiring, in the two
 * acts the screen now separates — open the list, search, choose, paste the
 * key, close; and then, on the connected card, choose the model. The models
 * arrive in between, silently, at the one moment the key is still in hand;
 * the key reaches the keyring and never the window. The encryption itself is
 * the unit suite's claim, with a fake keyring that really hides the bytes.
 */
interface Bridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

/** An OpenAI-compatible endpoint answering `GET /v1/models` with `models`. */
async function serving(models: string[]): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A one-entry catalogue pointing at an endpoint this test owns. */
async function catalogueFile(port: number): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "babelbook-catalog-")), "catalogue.json");
  await writeFile(path, JSON.stringify({
    at: "2026-08-26T00:00:00.000Z",
    providers: [{
      id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible",
      env: ["ACME_API_KEY"], api: `http://127.0.0.1:${port}/v1`,
      models: [{
        id: "acme-mini", name: "Acme Mini",
        cost: { input: 0.5, output: 2, cacheRead: null, cacheWrite: null },
        limit: { context: 128_000, output: 8_192 },
        toolCall: true, reasoning: false, structuredOutput: true, attachment: false,
      }],
    }],
  }));
  return path;
}

async function launch(
  userData: string, env: Record<string, string> = {},
): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, BABELBOOK_USER_DATA: userData, ...env },
  });
  // From the test, never from production code: an environment variable that
  // turned off encryption would be one typo away from doing it for real.
  await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true));
  return app;
}

test("connect, close, and only then choose: the walk does both acts", async () => {
  const endpoint = await serving(["acme-mini"]);
  const userData = await mkdtemp(join(tmpdir(), "babelbook-providers-"));
  const app = await launch(userData, {
    BABELBOOK_CATALOG_FOR_TEST: await catalogueFile(endpoint.port),
  });
  const window = await mainWindow(app);

  await window.getByTestId("nav-providers").click();
  await expect(window.getByTestId("providers-empty")).toBeVisible();
  await expect(window.getByTestId("catalog-state")).toContainText("2026-08-26");

  // The list lives behind a button now: opening it is the first gesture, and
  // it is a gesture of its own — connecting and choosing are two acts, and
  // this is where the first one starts. The custom endpoint is one more entry
  // in the list, not a button beside it.
  await window.getByTestId("open-connect").click();
  await expect(window.getByTestId("connect-modal")).toBeVisible();
  await expect(window.getByTestId("entry-custom")).toBeVisible();

  // 203 entries do not scroll: typing narrows the catalogue to the one entry.
  // It comes from the tail, so it carries its own facts — how many models it
  // serves, and which variable its key usually lives in — not a bare name.
  await window.getByTestId("catalog-query").fill("acme");
  const entry = window.getByTestId("entry-acme");
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(/1 (modelli|models)/);
  await expect(entry).toContainText("ACME_API_KEY");
  await entry.click();

  // The choice closed the list; what follows belongs to the form. Two fields:
  // the key, and a name that arrives already filled from the catalogue and
  // stays editable, so two keys on the same endpoint can be told apart. No
  // route to know, and no model chooser — the models are fetched when the form
  // is saved, not picked inside it.
  const form = window.getByTestId("provider-form");
  await expect(form).toBeVisible();
  await expect(window.getByTestId("connect-modal")).toBeHidden();
  await expect(window.getByTestId("provider-name")).toHaveValue("Acme");
  await expect(window.getByTestId("provider-base-url")).toHaveCount(0);
  await expect(form.locator("select")).toHaveCount(0);

  await window.getByTestId("provider-api-key").fill("sk-typed-by-the-user");
  await window.getByTestId("save-provider").click();

  // Connected providers stand apart, under their own title, above the list
  // the next connection would open.
  await expect(window.getByTestId("connected-title")).toBeVisible();
  const row = window.getByTestId("providers").locator("li.provider").first();
  await expect(row).toContainText("Acme");
  await expect(row.locator("[data-testid^='auth-']")).toBeVisible();

  // The second act, on the card: choose the model. The list arrived with the
  // save — while the key was still in hand, which is the only moment it could
  // be fetched — and the option carries the catalogue's own name for it.
  const model = row.locator("select");
  await expect(model.locator("option")).toHaveText(["Acme Mini"]);
  await model.selectOption("acme-mini");
  await expect(model).toHaveValue("acme-mini");

  // The reply that built this screen is the one the renderer actually got: if
  // the key rode along in it, it would be here. `hasKey` is all it says.
  const listed = await window.evaluate(() =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("providers.list", undefined));
  expect(JSON.stringify(listed)).not.toContain("sk-typed-by-the-user");
  expect(JSON.stringify(listed)).toContain('"hasKey":true');

  await app.close();
  endpoint.server.closeAllConnections?.();
  await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
});

test("a local runtime is one more entry in the list, and needs no key", async () => {
  // A server on "Ollama's" port — which the test, not the machine, chose: a
  // developer with a real Ollama running must not make this test say
  // something about that one. The catalogue is the bundled one, so the modal
  // opens on the recommended ten — which the runtime's entry precedes.
  const fakeOllama = await serving(["gemma3:12b", "my-own-finetune"]);
  const userData = await mkdtemp(join(tmpdir(), "babelbook-providers-local-"));
  const app = await launch(userData, {
    BABELBOOK_LOCAL_PORTS_FOR_TEST: `ollama=${fakeOllama.port}`,
  });
  const window = await mainWindow(app);

  await window.getByTestId("nav-providers").click();
  await window.getByTestId("open-connect").click();

  // The machine's runtimes are known before any search is typed, so they come
  // first in the list — ahead of the recommended, which the modal opened on.
  const local = window.getByTestId("entry-ollama");
  await expect(local).toBeVisible();
  await expect(local).toContainText("Ollama");
  const firstEntry = window.getByTestId("connect-modal").locator("a").first();
  await expect(firstEntry).toHaveAttribute("data-testid", "entry-ollama");
  await local.click();

  // No key to type: the runtime runs on this machine. And the models are the
  // server's own list, not anything a catalogue guessed — they arrive with
  // the choice, so the form holds no chooser either.
  const form = window.getByTestId("provider-form");
  await expect(form).toBeVisible();
  await expect(window.getByTestId("no-key-needed")).toBeVisible();
  await expect(window.getByTestId("provider-api-key")).toHaveCount(0);
  await expect(form.locator("select")).toHaveCount(0);

  await window.getByTestId("save-provider").click();
  const row = window.getByTestId("providers").locator("li.provider").first();
  await expect(row).toContainText("Ollama");
  // The card says how this one authenticates: an endpoint on this machine,
  // with no key to hold.
  await expect(row.locator("[data-testid^='auth-']")).toContainText("Locale");

  // The second act is the same gesture as for any provider: choose the model
  // on the card, from the list the runtime itself declared.
  const model = row.locator("select");
  await expect(model.locator("option")).toHaveText(["gemma3:12b", "my-own-finetune"]);
  await model.selectOption("my-own-finetune");
  await expect(model).toHaveValue("my-own-finetune");
  await app.close();

  fakeOllama.server.closeAllConnections?.();
  await new Promise<void>((resolve) => fakeOllama.server.close(() => resolve()));
});
