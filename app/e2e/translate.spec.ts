import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { readEpub } from "../../core/epub/index.ts";
import { mainWindow, seedProvider } from "./support.ts";

/**
 * The whole application, end to end, with the deterministic backend.
 *
 * Unit tests cover every way a backend can fail; only this can show that the
 * three processes agree all the way to a book — the preload loads, the run
 * starts, the engine translates through its proxy, the machine decides, and
 * the composer writes an EPUB a reader can open. And only the second half can
 * show that a pause, a restart and a resume retranslate nothing.
 */

interface Bridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

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

async function projects(window: Page): Promise<Array<{ id: string; state: string; progress: { done: number; total: number } }>> {
  return window.evaluate(() =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("projects.list", {}));
}

async function settings(window: Page, patch: Record<string, unknown>): Promise<void> {
  await window.evaluate((body) =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("settings.set", body), patch);
}

async function until(
  window: Page,
  condition: (state: Awaited<ReturnType<typeof projects>>[number]) => boolean,
  what: string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const listed = await projects(window);
    if (listed.length > 0 && condition(listed[0]!)) return;
    await window.waitForTimeout(50);
  }
  throw new Error(`condition not reached: ${what}`);
}

/** One paragraph the planner cannot pair with another: a chunk of its own. */
const LONG_PARAGRAPH =
  "A paragraph long enough that the planner gives it a chunk of its own, because chunks pack units up to six thousand characters and this block is deliberately past half of that budget. "
    .repeat(24);

async function projectOutput(dir: string): Promise<{ projectId: string; epubPath: string }> {
  const projectsDir = join(dir, "projects");
  for (const projectId of await readdir(projectsDir)) {
    const outputDir = join(projectsDir, projectId, "output");
    const produced = (await readdir(outputDir).catch(() => [] as string[]))
      .filter((name) => name.endsWith(".it.epub"));
    if (produced.length > 0) return { projectId, epubPath: join(outputDir, produced[0]!) };
  }
  throw new Error("no translated EPUB was written");
}

test("a whole book through the app, from the file to the translated EPUB", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-run-"));
  const epub = join(dir, "book.epub");
  await writeFile(epub, await buildEpub({
    title: "Whole Run", language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two</p>" }],
  }));

  const { app, window } = await launch(dir, { BABELBOOK_EPUB_FOR_TEST: epub });
  await createProject(window);

  await settings(window, { autoAcceptTerms: true, autoAcceptExclusions: true });
  await window.getByTestId("library").locator("li.tile").first().getByTestId("start").click();

  await until(window, (project) => project.state === "done", "the run reaches done");
  await expect(window.getByTestId("library").locator("li.tile").first()).toContainText("Completo");

  // The report is the only place the composition's verdict and the run's cost
  // survive. Both used to be computed and dropped, so a report would have
  // claimed every book passed no checks and cost nothing.
  const listed = await projects(window);
  const report = await window.evaluate((projectId) =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("report.get", { projectId }),
    listed[0]!.id) as {
      status: string;
      invariants: Array<{ id: string; ok: boolean }>;
      epubcheck: { ran: boolean };
      cost: { tokensIn: number; tokensOut: number };
      outputPath: string | null;
    };

  expect(report.status).toBe("complete");
  expect(report.invariants.length).toBeGreaterThan(0);
  expect(report.invariants.every((invariant) => invariant.ok)).toBe(true);
  expect(report.outputPath).toContain(".it.epub");
  expect(report.cost.tokensIn).toBeGreaterThan(0);
  expect(report.cost.tokensOut).toBeGreaterThan(0);

  await app.close();

  const { epubPath } = await projectOutput(dir);
  const out = await readEpub(await readFile(epubPath));
  const document = out.get("OEBPS/c1.xhtml")!.toString("utf8");
  expect(document).toContain("[FAKE]");
  expect(document).toContain('lang="it"');
  expect(out.get("OEBPS/content.opf")!.toString("utf8")).toContain("<dc:language>it</dc:language>");
});

test("paused, restarted and resumed without retranslating what was done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-pause-"));
  const epub = join(dir, "book.epub");
  const paragraphs = Array.from({ length: 16 }, () => `<p>${LONG_PARAGRAPH}</p>`).join("");
  await writeFile(epub, await buildEpub({
    title: "Pause And Resume", language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: paragraphs }],
  }));

  const callLog = join(dir, "fake-calls.log");
  const pacing = { BABELBOOK_FAKE_DELAY_MS: "120", BABELBOOK_FAKE_LOG: callLog };
  const { app, window } = await launch(dir, { BABELBOOK_EPUB_FOR_TEST: epub, ...pacing });
  await createProject(window);

  // One chunk in flight at a time: the first stored unit is unambiguously the
  // first asked one, which is what the no-retranslation claim rests on.
  await settings(window, { autoAcceptTerms: true, autoAcceptExclusions: true, concurrency: 1 });
  await window.getByTestId("library").locator("li.tile").first().getByTestId("start").click();

  await until(window, (project) => project.state === "running" && project.progress.done >= 1,
    "the first unit is translated");
  await window.getByTestId("library").locator("li.tile").first().getByTestId("pause").click();
  await until(window, (project) => project.state === "paused", "the run pauses");
  await app.close();

  const reopened = await launch(dir, pacing);
  await expect(reopened.window.getByTestId("library").locator("li.tile").first()).toBeVisible();
  const afterRestart = (await projects(reopened.window))[0]!;
  expect(afterRestart.state).toBe("paused");

  await reopened.window.getByTestId("library").locator("li.tile").first().getByTestId("resume").click();
  await until(reopened.window, (project) => project.state === "done", "the resumed run reaches done");
  await reopened.app.close();

  // The resume asked for everything except what it already had: the first
  // translated unit appears exactly once in the whole call log, and the log
  // names every unit the book carries.
  const calls = (await readFile(callLog, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { kind: string; ids: string[] });
  const asked = calls.filter((call) => call.kind === "units").flatMap((call) => call.ids);
  const first = asked[0]!;
  expect(asked.filter((id) => id === first)).toHaveLength(1);
  expect(new Set(asked).size).toBe(afterRestart.progress.total);

  const { epubPath } = await projectOutput(dir);
  const out = await readEpub(await readFile(epubPath));
  expect(out.get("OEBPS/c1.xhtml")!.toString("utf8")).toContain("[FAKE]");
});
