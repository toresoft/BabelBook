import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { mainWindow, seedProvider } from "./support.ts";

/**
 * A provider that stumbles, end to end.
 *
 * Unit tests cover the classifier and the backoff in isolation; only this can
 * show that a 429 travels the whole way — thrown by a backend in the engine
 * process, classified, waited out, retried, written into the reader's log, and
 * either survived or turned into a paused project with a reason on the screen.
 *
 * The failures come from the deterministic backend, told to stumble by
 * `BABELBOOK_FAKE_FAILURES`. Every other way of producing a 429 depends on
 * somebody else's endpoint having a bad afternoon, which is to say it depends
 * on the suite being unable to prove this at all.
 */

interface Bridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

interface Listed {
  id: string;
  state: string;
  progress: { done: number; total: number };
}

/**
 * Each spec here carries its own launcher, as the other five do. Extracting
 * one would touch five files that are not what this change is about.
 */
async function launch(
  userData: string,
  env: Record<string, string> = {},
): Promise<{ app: ElectronApplication; window: Page }> {
  await seedProvider(userData);
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      BABELBOOK_USER_DATA: userData,
      BABELBOOK_FAKE_BACKEND: "1",
      ...env,
    },
  });
  return { app, window: await mainWindow(app) };
}

async function createProject(window: Page): Promise<void> {
  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();
  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();
  await expect(window.getByTestId("library").locator("li.tile").first()).toBeVisible();
}

async function projects(window: Page): Promise<Listed[]> {
  return window.evaluate(() =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("projects.list", {})) as Promise<Listed[]>;
}

async function settings(window: Page, patch: Record<string, unknown>): Promise<void> {
  await window.evaluate((body) =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("settings.set", body), patch);
}

async function until(
  window: Page,
  condition: (project: Listed) => boolean,
  what: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 40_000) {
    const listed = await projects(window);
    if (listed.length > 0 && condition(listed[0]!)) return;
    await window.waitForTimeout(50);
  }
  throw new Error(`condition not reached: ${what}`);
}

async function openProject(window: Page): Promise<void> {
  await window.getByTestId("library").locator("li.tile").first().click();
  await expect(window.getByTestId("side")).toBeVisible();
}

/** The book, small on purpose: what is under test is the stumble, not the size. */
async function book(dir: string): Promise<string> {
  const epub = join(dir, "book.epub");
  await writeFile(epub, await buildEpub({
    title: "Resilience", language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two</p>" }],
  }));
  return epub;
}

/** Every NDJSON line the run left behind, from both processes. */
async function diagnostics(userData: string): Promise<string> {
  const projectsDir = join(userData, "projects");
  const collected: string[] = [];
  for (const projectId of await readdir(projectsDir)) {
    const logs = join(projectsDir, projectId, "logs");
    for (const name of await readdir(logs).catch(() => [] as string[])) {
      collected.push(await readFile(join(logs, name), "utf8"));
    }
  }
  return collected.join("\n");
}

test("a provider that stumbles twice does not cost the book", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-retry-"));
  const { app, window } = await launch(dir, {
    BABELBOOK_EPUB_FOR_TEST: await book(dir),
    BABELBOOK_FAKE_FAILURES: "429x2",
  });

  try {
    await createProject(window);
    await settings(window, { autoAcceptTerms: true, autoAcceptExclusions: true });
    await window.getByTestId("library").locator("li.tile").first().getByTestId("start").click();

    // Before this existed, one 429 anywhere in a book ended the run: the SDK
    // adapter retries nothing by design, and the engine's own attempts only
    // ever counted answers it had received and rejected.
    await until(window, (project) => project.state === "done", "the run survives two rate limits");

    await openProject(window);
    await window.getByTestId("side-tab-log").click();

    // The line the Registro was missing, and the one that closes it: a retry
    // whose recovery is never announced reads like a run that never came back.
    const log = window.getByTestId("side-panel-log");
    await expect(log).toContainText("Tentativo 1 di 5");
    await expect(log).toContainText("ha ripreso a rispondere");
    // The reason is Italian, not an identifier.
    await expect(log).toContainText("limite di frequenza");
    await expect(log).not.toContainText("PROVIDER_RATE_LIMITED");
  } finally {
    await app.close();
  }

  // The file holds what the curated log leaves out, under the code the
  // classifier chose.
  expect(await diagnostics(dir)).toContain("PROVIDER_RATE_LIMITED");
});

test("a provider that never comes back leaves the book paused, and says why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-exhausted-"));
  const { app, window } = await launch(dir, {
    BABELBOOK_EPUB_FOR_TEST: await book(dir),
    // Credit that has run out: the one 429-shaped failure no wait can fix, and
    // so the one that must not be retried five times before saying so.
    BABELBOOK_FAKE_FAILURES: "402",
  });

  try {
    await createProject(window);
    await settings(window, { autoAcceptTerms: true, autoAcceptExclusions: true });
    await window.getByTestId("library").locator("li.tile").first().getByTestId("start").click();

    // Paused, not failed. Resuming tomorrow finishes this book, and the badge
    // used to say "Rifiutato" of a book nobody had rejected.
    await until(window, (project) => project.state === "paused", "the run pauses");
    await openProject(window);
    await expect(window.getByTestId("side-status")).toHaveText("In pausa");

    const card = window.getByTestId("alert-stopped");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Il credito del provider è esaurito.");
    // What to do next, which is the whole point of classifying.
    await expect(card).toContainText("Ricarica");

    await window.getByTestId("side-tab-log").click();
    await expect(window.getByTestId("side-panel-log")).toContainText("messa in pausa");

    // And the raw chronicle is reachable without leaving the window.
    await window.getByTestId("side-view-raw").click();
    await expect(window.getByTestId("side-raw")).toContainText("PROVIDER_OUT_OF_CREDIT");
  } finally {
    await app.close();
  }
});
