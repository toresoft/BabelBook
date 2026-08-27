import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { mainWindow } from "./support.ts";

/**
 * The screens, looked at.
 *
 * No pixel comparison: a test that fails at every two-pixel shift is
 * switched off within a month. What can be asserted is asserted — no text on
 * a background of its own colour, a dark theme that truly changes the
 * background, no text wider than its box — and the rest is what the
 * screenshots are for: a plan about looks that nobody looked at is exactly
 * the mistake it set out to correct. They land in e2e/screenshots, one per
 * screen per theme, to be opened and read.
 */

const SHOTS = join(import.meta.dirname, "screenshots");
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

async function setTheme(app: ElectronApplication, window: Page, theme: Theme): Promise<string> {
  await app.evaluate(({ nativeTheme }, source) => {
    nativeTheme.themeSource = source;
  }, theme);
  // The class is the honest witness that the theme arrived: the renderer is
  // told by the main process, and the colours follow the class.
  await expect.poll(() => window.evaluate(() =>
    document.documentElement.classList.contains("theme-dark"))).toBe(theme === "dark");
  await window.waitForTimeout(100);
  return window.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

/**
 * What holds on every screen, checked in the page itself.
 *
 * Text is read against the first background that actually paints behind it,
 * so a paragraph over a card over the window is measured against the card —
 * and "the same colour twice" cannot hide behind an inherited value.
 */
const READABLE = (): string[] => {
  const parse = (color: string): [number, number, number] => {
    const [r, g, b] = color.match(/[\d.]+/g)!.map(Number);
    return [r, g, b];
  };
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]: [number, number, number]): number =>
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const ratio = (a: [number, number, number], b: [number, number, number]): number => {
    const one = luminance(a);
    const two = luminance(b);
    return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
  };
  const paints = (el: Element): string => {
    for (let at = el; at instanceof Element; at = at.parentElement) {
      const bg = getComputedStyle(at).backgroundColor;
      if (bg !== "rgba(0, 0, 0, 0)") return bg;
    }
    return "rgb(255, 255, 255)";
  };

  const problems: string[] = [];
  for (const el of document.querySelectorAll("body *")) {
    const hasText = [...el.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
    if (!hasText || el.getClientRects().length === 0) continue;

    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;

    const back = paints(el);
    if (ratio(parse(style.color), parse(back)) <= 2) {
      problems.push(`${el.tagName}.${el.className}: text ${style.color} on ${back}`);
    }
    if (el.scrollWidth > el.clientWidth + 1) {
      problems.push(`${el.tagName}.${el.className}: text wider than its box`);
    }
  }
  return problems;
};

/** The walk back to the shelf, from whichever screen the walk left us on. */
async function home(window: Page): Promise<void> {
  const back = window.locator(".project__back, .settings__back").first();
  if (await back.count()) await back.click();
  await window.getByTestId("library").waitFor();
}

const openBook = async (window: Page): Promise<void> => {
  await home(window);
  await window.locator("a[data-testid^='open-']").first().click();
  await window.getByTestId("overview").waitFor();
};

const tab = (name: string, panel: string) => async (window: Page): Promise<void> => {
  await openBook(window);
  await window.getByTestId(`tab-${name}`).click();
  await window.getByTestId(panel).waitFor();
};

const section = (name: string, panel: string) => async (window: Page): Promise<void> => {
  await home(window);
  await window.getByTestId("settings").click();
  await window.getByTestId(`section-${name}`).click();
  await window.getByTestId(panel).waitFor();
};

test("every screen, in both themes, saying what it must", async () => {
  test.setTimeout(240_000);
  const dir = await mkdtemp(join(tmpdir(), "babelbook-screens-"));
  const epub = join(dir, "book.epub");
  await writeFile(epub, await buildEpub({
    title: "Screen Walk", language: "en",
    documents: [
      { path: "OEBPS/c1.xhtml", xhtml: "<p>The road to Rivendell.</p><p>And back again.</p>" },
      { path: "OEBPS/c2.xhtml", xhtml: "<p>gem install rails</p>" },
    ],
  }));

  const app = await electron.launch({
    args: ["."],
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, BABELBOOK_USER_DATA: dir, BABELBOOK_EPUB_FOR_TEST: epub },
  });
  const window = await mainWindow(app);
  await mkdir(SHOTS, { recursive: true });

  // The new-project screen is the only one that cannot be revisited: leaving
  // it is abandoning, which asks. So it is caught now, in both themes, and
  // left through its primary act — which the rest of the walk needs anyway.
  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();
  await window.getByTestId("estimate").waitFor();

  const lightBody = await setTheme(app, window, "light");
  let problems = await window.evaluate(READABLE);
  expect(problems).toEqual([]);
  await window.screenshot({ path: join(SHOTS, "new-project-light.png") });

  const darkBody = await setTheme(app, window, "dark");
  // The dark theme is not a rumour: the floor under everything changes.
  expect(darkBody).not.toEqual(lightBody);
  problems = await window.evaluate(READABLE);
  expect(problems).toEqual([]);
  await window.screenshot({ path: join(SHOTS, "new-project-dark.png") });
  await setTheme(app, window, "light");

  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();
  await window.getByTestId("library").waitFor();

  // One glossary, so the section it lives in is not photographed empty.
  await window.getByTestId("settings").click();
  await window.getByTestId("section-glossaries").click();
  await window.getByTestId("new-glossary").click();
  await window.getByTestId("glossary-name").fill("fantasy");
  await window.getByTestId("glossary-description").fill("Epic fantasy with invented names");
  await window.getByTestId("add-gterm").click();
  await window.getByTestId("gterm-source-0").fill("Rivendell");
  await window.getByTestId("save-glossary").click();

  const screens: Array<{ name: string; open: (window: Page) => Promise<void> }> = [
    { name: "library", open: home },
    { name: "project-overview", open: openBook },
    { name: "project-units", open: tab("units", "units") },
    { name: "project-terms", open: tab("terms", "terms") },
    { name: "project-exclusions", open: tab("exclusions", "exclusions") },
    { name: "project-report", open: tab("report", "report") },
    { name: "settings-providers", open: section("providers", "providers") },
    { name: "settings-glossaries", open: section("glossaries", "glossaries") },
    { name: "settings-translation", open: section("translation", "prefs-translation") },
    { name: "settings-application", open: section("application", "prefs-application") },
  ];

  for (const theme of THEMES) {
    await setTheme(app, window, theme);
    for (const screen of screens) {
      await screen.open(window);
      const found = await window.evaluate(READABLE);
      expect(found, `${screen.name} (${theme})`).toEqual([]);
      await window.screenshot({ path: join(SHOTS, `${screen.name}-${theme}.png`) });
    }
  }

  await app.close();
});
