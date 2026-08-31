import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { mainWindow, seedProvider } from "./support.ts";

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
  // The attribute is the honest witness that the theme arrived: the renderer
  // is told by the main process, and the colours follow the attribute.
  const expected = theme === "dark" ? "babelbook-dark" : "babelbook";
  await expect.poll(() => window.evaluate(() =>
    document.documentElement.dataset["theme"])).toBe(expected);
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
  // The controls now speak oklab, and their mixes settle in oklch — a
  // disabled button's colour is one of those — and the browser will not
  // say either back in rgb, so both are converted here, with the same
  // arithmetic the contrast below is made of.
  const parse = (color: string): [number, number, number] => {
    const numbers = (color.match(/-?[\d.]+/g) ?? ["0", "0", "0"]).map(Number);
    // oklch's second and third numbers are chroma and hue — an angle in
    // degrees — which become oklab's a and b as their cosine and sine.
    let [l, a, b] = numbers;
    if (color.startsWith("oklch(")) {
      const hue = (numbers[2] * Math.PI) / 180;
      a = numbers[1] * Math.cos(hue);
      b = numbers[1] * Math.sin(hue);
    } else if (!color.startsWith("oklab(")) {
      return [numbers[0], numbers[1], numbers[2]];
    }
    const cube = (v: number): number => v ** 3;
    const lms = [
      cube(l + 0.3963377774 * a + 0.2158037573 * b),
      cube(l - 0.1055613458 * a - 0.0638541728 * b),
      cube(l - 0.0894841775 * a - 1.291485548 * b),
    ];
    const linear = [
      4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
      -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
      -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
    ];
    return linear.map((c) => {
      const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, srgb)) * 255);
    }) as [number, number, number];
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
      // A colour with alpha is a wash, not a surface: it tints what is
      // below instead of covering it, so the text is read against the
      // first opaque colour up the tree — a disabled button's colour-mix
      // is a wash, and the card behind it is the surface.
      const alpha = bg.startsWith("rgba(") || bg.includes("/")
        ? Number(bg.match(/(?:,|\/)\s*([\d.]+)\s*\)$/)?.[1] ?? 1)
        : 1;
      if (bg !== "rgba(0, 0, 0, 0)" && alpha >= 1) return bg;
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
    // An element that declares `text-overflow: ellipsis` is wider than its box
    // by design and shows a … where it was cut — a document path in a narrow
    // column is meant to do that. What this looks for is text that overruns
    // with nothing to say so.
    const truncates = style.textOverflow === "ellipsis";
    if (!truncates && el.scrollWidth > el.clientWidth + 1) {
      problems.push(`${el.tagName}.${el.className}: text wider than its box`);
    }
    // The same question on the other axis, which this audit did not ask and
    // so did not catch: a pill with a fixed height and a label too long for
    // its column wraps the text and keeps the border where it was. The words
    // come out through the top and the bottom, and the border reads as a line
    // struck through them. A scroller is exempt — content taller than the box
    // is what a scroller is.
    const scrolls = /auto|scroll/.test(style.overflowY);
    if (!scrolls && el.scrollHeight > el.clientHeight + 1) {
      problems.push(`${el.tagName}.${el.className}: text taller than its box`);
    }
  }
  return problems;
};

/** The walk back to the shelf, from whichever screen the walk left us on. */
async function home(window: Page): Promise<void> {
  // The connect dialog, when it is open, covers the column and everything
  // else: closing it is the only way out the interface offers, so the walk
  // takes that way before looking for any other.
  const close = window.getByTestId("close-connect");
  if (await close.isVisible()) await close.click();
  // A project or a settings section has a back; a group of the shelf has
  // none, because it is the shelf — and the way back to every project is
  // the column's own first link.
  const back = window.locator(".project__back, .settings__back").first();
  if (await back.count()) await back.click();
  else await window.getByTestId("nav-all").click();
  await window.getByTestId("library").waitFor();
}

const openBook = async (window: Page): Promise<void> => {
  await home(window);
  await window.locator("a[data-testid^='open-']").first().click();
  // The tab a book opens on: the overview is gone, and its facts live in the
  // column beside the work instead.
  await window.getByTestId("tab-terms").waitFor();
};

const tab = (name: string, panel: string) => async (window: Page): Promise<void> => {
  await openBook(window);
  await window.getByTestId(`tab-${name}`).click();
  await window.getByTestId(panel).waitFor();
};

const section = (name: string, panel: string) => async (window: Page): Promise<void> => {
  await home(window);
  await window.getByTestId(`nav-${name}`).click();
  await window.getByTestId(panel).waitFor();
};

/**
 * The connect modal, reached the only way it opens: from the providers screen.
 *
 * Opening it asks the empty question, and the ten recommended arrive with the
 * answer — the modal is not at rest until the last of them has, or the shot
 * would catch the frame before the list lands.
 */
const connect = async (window: Page): Promise<void> => {
  await section("providers", "providers")(window);
  await window.getByTestId("open-connect").click();
  await window.getByTestId("connect-modal").waitFor();
  await window.getByTestId("entry-cerebras").waitFor(); // the last of the ten
};

/**
 * A group of the shelf, reached the only way it now is: from the column.
 *
 * The walk's single book never stops at a gate, so `to-approve` is empty while
 * the library is not — and the page must say the group's truth, not the
 * library's. The column's own link wearing the active class is the witness the
 * page was reached at all.
 */
const bucket = (name: string) => async (window: Page): Promise<void> => {
  await home(window);
  await window.getByTestId(`nav-${name}`).click();
  await window.getByTestId("library").waitFor();
  await expect(window.getByTestId(`nav-${name}`)).toHaveClass(/menu-active/);
  await expect(window.locator(".library__empty")).toHaveText(/Nessun libro in questo gruppo/);
};

test("every screen, in both themes, saying what it must", async () => {
  test.setTimeout(240_000);
  const dir = await mkdtemp(join(tmpdir(), "babelbook-screens-"));
  const epub = join(dir, "book.epub");
  await writeFile(epub, await buildEpub({
    title: "Screen Walk", language: "en",
    documents: [
      { path: "OEBPS/c1.xhtml", xhtml: "<p>The road to Rivendell.</p><p>And back again.</p>" },
      // Two exclusions, not one, and deliberately of different kinds: the one
      // the author marked wears the longest label any state has, which is the
      // only way the exclusions screen is photographed at its widest.
      {
        path: "OEBPS/c2.xhtml",
        xhtml: "<p>gem install rails</p><p translate=\"no\">Ainulindalë</p>",
      },
    ],
  }));

  await seedProvider(dir);
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

  // The arrow is the application's character: daisyUI ships the pointing
  // hand, and this holds the line the foundation must not cross.
  expect(await window.evaluate(() =>
    getComputedStyle(document.querySelector("button.btn")!).cursor)).toBe("default");

  const lightBody = await setTheme(app, window, "light");
  // The walk arrived here by leaving /projects/all, so nav-all wears the
  // same mid-flight colour change the loop below waits out of every
  // screen — this one is measured at rest too.
  await window.waitForTimeout(300);
  let problems = await window.evaluate(READABLE);
  expect(problems).toEqual([]);
  await window.screenshot({ path: join(SHOTS, "new-project-light.png") });

  const darkBody = await setTheme(app, window, "dark");
  // The dark theme is not a rumour: the floor under everything changes.
  expect(darkBody).not.toEqual(lightBody);
  await window.waitForTimeout(300);
  problems = await window.evaluate(READABLE);
  expect(problems).toEqual([]);
  await window.screenshot({ path: join(SHOTS, "new-project-dark.png") });
  await setTheme(app, window, "light");

  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();
  await window.getByTestId("library").waitFor();

  // One glossary, so the section it lives in is not photographed empty.
  await window.getByTestId("nav-glossaries").click();
  await window.getByTestId("glossaries").waitFor();
  await window.getByTestId("new-glossary").click();
  await window.getByTestId("glossary-name").fill("fantasy");
  await window.getByTestId("glossary-description").fill("Epic fantasy with invented names");
  await window.getByTestId("add-gterm").click();
  await window.getByTestId("gterm-source-0").fill("Rivendell");
  await window.getByTestId("save-glossary").click();

  const screens: Array<{ name: string; open: (window: Page) => Promise<void> }> = [
    { name: "library", open: home },
    { name: "library-to-approve", open: bucket("to-approve") },
    { name: "project-units", open: tab("units", "units") },
    { name: "project-terms", open: tab("terms", "terms") },
    { name: "project-exclusions", open: tab("exclusions", "exclusions") },
    { name: "project-report", open: tab("report", "report") },
    { name: "settings-providers", open: section("providers", "providers") },
    { name: "settings-providers-connect", open: connect },
    { name: "settings-glossaries", open: section("glossaries", "glossaries") },
    { name: "settings-translation", open: section("translation", "prefs-translation") },
    { name: "settings-application", open: section("application", "prefs-application") },
  ];

  for (const theme of THEMES) {
    await setTheme(app, window, theme);
    for (const screen of screens) {
      await screen.open(window);
      // daisyUI's menu moves a column link's colour from the active white
      // back to the page's text over 200ms, and a checker reading
      // mid-flight sees a grey that exists in no stylesheet — a frame of
      // the change, not the screen. The screen is measured at rest.
      await window.waitForTimeout(300);
      const found = await window.evaluate(READABLE);
      expect(found, `${screen.name} (${theme})`).toEqual([]);
      await window.screenshot({ path: join(SHOTS, `${screen.name}-${theme}.png`) });
    }
  }

  await app.close();
});
