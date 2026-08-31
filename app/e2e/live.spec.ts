import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { mainWindow, seedProvider } from "./support.ts";

/**
 * A screen that does not have to be poked.
 *
 * Every list on a project's screen used to load once and then sit there: a run
 * wrote translations underneath the units tab and the tab went on saying "not
 * yet translated" until the reader changed a filter. This drives a real run
 * with a real window and never touches the list again.
 *
 * The tray's icon is checked here too, because it is the same kind of silent
 * failure: an image Electron cannot decode is a tray nobody can see, and
 * nothing says so.
 */
test("the units tab keeps up with the run, and the tray icon is a real image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-live-"));
  const epub = join(dir, "book.epub");
  const paragraphs = Array.from({ length: 12 }, (_, at) =>
    `<p>Paragraph ${at + 1}: the road to Rivendell was long.</p>`).join("");
  await writeFile(epub, await buildEpub({
    title: "Live", language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: paragraphs }],
  }));

  await seedProvider(dir);
  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env, BABELBOOK_USER_DATA: dir, BABELBOOK_EPUB_FOR_TEST: epub,
      BABELBOOK_FAKE_BACKEND: "1", BABELBOOK_FAKE_DELAY_MS: "150",
    },
  });
  const window = await mainWindow(app);

  // The tray's icon, decoded by Electron itself: an empty image is a tray
  // nobody can see, and it fails silently.
  const icon = /TRAY_ICON\s*=\s*\n?\s*"([^"]+)"/
    .exec(await readFile(join(import.meta.dirname, "../main/icons.ts"), "utf8"))![1]!;
  expect(await app.evaluate(({ nativeImage }, url) => {
    const image = nativeImage.createFromDataURL(url);
    return { empty: image.isEmpty(), size: image.getSize() };
  }, icon)).toEqual({ empty: false, size: { width: 32, height: 32 } });

  // Both gates are accepted without asking — that is now the default a new
  // project is born with — because this check is about a list keeping up with
  // a run, and a gate stops the run and moves the tab away from it.
  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();
  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();
  await window.getByTestId("library").locator("li.tile a.tile__title").first().click();

  // Sit on the units tab and never touch it again.
  await window.getByTestId("tab-units").click();
  const first = window.locator(".table__row").first();
  await expect(first).toContainText("Non ancora tradotta");

  await window.getByTestId("project-start").click();

  // No click, no filter, no reload: the row must change by itself.
  await expect(first).toContainText("[FAKE]", { timeout: 60_000 });

  await app.close();
});
