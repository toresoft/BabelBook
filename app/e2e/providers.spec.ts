import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mainWindow } from "./support.ts";

/**
 * Adding a provider through the interface, which is the only thing that makes
 * the encrypted store reachable by a user.
 *
 * The catalogue is a file this test writes and the main process serves, and
 * the endpoints are HTTP servers this test runs: nothing here reaches the
 * network or needs a real provider. What is proved is the wiring — search,
 * choose, paste, and the models arrive; the key reaches the keyring and never
 * the window. The encryption itself is the unit suite's claim, with a fake
 * keyring that really hides the bytes.
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

test("search, choose, paste: the models arrive and the key never does", async () => {
  const endpoint = await serving(["acme-mini"]);
  const userData = await mkdtemp(join(tmpdir(), "babelbook-providers-"));
  const app = await launch(userData, {
    BABELBOOK_CATALOG_FOR_TEST: await catalogueFile(endpoint.port),
  });
  const window = await mainWindow(app);

  await window.getByTestId("settings").click();
  await expect(window.getByTestId("providers-empty")).toBeVisible();
  await expect(window.getByTestId("catalog-state")).toContainText("2026-08-26");

  // 203 entries do not scroll: typing narrows the catalogue to the one entry.
  await window.getByTestId("catalog-query").fill("acme");
  await expect(window.getByTestId("entry-acme")).toBeVisible();
  await window.getByTestId("entry-acme").click();

  // One field, the key. No name to invent, no route to know, no model id to
  // type: the endpoint will say what it serves.
  await window.getByTestId("provider-api-key").fill("sk-typed-by-the-user");
  await window.getByTestId("find-models").click();

  const model = window.getByTestId("model-acme-mini");
  await expect(model).toBeVisible();
  await expect(model).toContainText("Acme Mini");
  // Price and window are on the row, because the catalogue knows them.
  await expect(model).toContainText("128000");
  await expect(model).toContainText("0.5");

  const form = window.getByTestId("provider-form");
  await expect(form.locator("input")).toHaveCount(1); // the key, and nothing else

  await window.getByTestId("save-provider").click();
  const row = window.getByTestId("providers").locator("li.provider").first();
  await expect(row).toContainText("Acme");
  await expect(row.getByTestId("key-set")).toBeVisible();

  // The reply that built this screen is the one the renderer actually got: if
  // the key rode along in it, it would be here. `hasKey` is all it says.
  const listed = await window.evaluate(() =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("providers.list", undefined));
  expect(JSON.stringify(listed)).not.toContain("sk-typed-by-the-user");
  expect(JSON.stringify(listed)).toContain("hasKey");

  await app.close();
  endpoint.server.closeAllConnections?.();
  await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
});

test("a local runtime appears on its own, with its own models and no key field", async () => {
  // A server on "Ollama's" port — which the test, not the machine, chose: a
  // developer with a real Ollama running must not make this test say
  // something about that one.
  const fakeOllama = await serving(["gemma3:12b", "my-own-finetune"]);
  const userData = await mkdtemp(join(tmpdir(), "babelbook-providers-local-"));
  const app = await launch(userData, {
    BABELBOOK_LOCAL_PORTS_FOR_TEST: `ollama=${fakeOllama.port}`,
  });
  const window = await mainWindow(app);

  await window.getByTestId("settings").click();
  const local = window.getByTestId("local-ollama");
  await expect(local).toBeVisible();
  await expect(local).toContainText("Ollama");
  await local.click();

  // No key to type: the runtime runs on this machine. And the models are the
  // server's own list, not anything a catalogue guessed.
  await expect(window.getByTestId("provider-form")).toBeVisible();
  await expect(window.getByTestId("provider-api-key")).toHaveCount(0);
  await expect(window.getByTestId("model-gemma3:12b")).toBeVisible();
  await expect(window.getByTestId("model-my-own-finetune")).toBeVisible();

  await window.getByTestId("save-provider").click();
  const row = window.getByTestId("providers").locator("li.provider").first();
  await expect(row).toContainText("Ollama");
  await expect(row.getByTestId("key-missing")).toBeVisible();
  await app.close();

  fakeOllama.server.closeAllConnections?.();
  await new Promise<void>((resolve) => fakeOllama.server.close(() => resolve()));
});
