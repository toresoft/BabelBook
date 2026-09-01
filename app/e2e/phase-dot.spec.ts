import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * The dot beside the phase that is running.
 *
 * It is the one mark in the column drawn by daisyUI rather than by us, and
 * daisyUI draws a spinner in a way nothing else here does: the shape is a
 * `mask-image`, and what the mask reveals is the element's own
 * `background-color: currentColor`. The background *is* the spinner.
 *
 * That makes it fragile in a way no other dot is. Component stylesheets are
 * injected unlayered, and everything daisyUI ships lives inside `@layer`, so
 * any `background` a component rule sets on that element wins whatever its
 * specificity — and wins by painting nothing. The dot keeps its size, keeps
 * its colour, and disappears.
 *
 * So this checks the one thing a screenshot of a still page cannot: that the
 * running dot still paints. It reads the classes out of the template rather
 * than repeating them, so it goes on testing whatever is actually shipped.
 */

/* Anchored to this file, not to the working directory: the suite is run both
   from the repo root and from `app/`, and a relative path is right in one. */
const ROOT = join(import.meta.dirname, "..");
const PANEL = join(ROOT, "renderer/src/app/project/side/progress-panel");

/** The built sheet, where tailwind, daisyUI and the layers really are. */
async function builtStylesheet(): Promise<string> {
  const dir = join(ROOT, "dist/renderer");
  const found = (await readdir(dir)).find((name) => /^styles-.*\.css$/.test(name));
  if (found === undefined) throw new Error(`no built stylesheet in ${dir}; run npm run build -w app`);
  return join(dir, found);
}

/** The class list the template gives the running dot, taken from the template. */
async function runningDotClasses(): Promise<string> {
  const template = await readFile(`${PANEL}.html`, "utf8");
  const found = /<span class="([^"]*\bloading\b[^"]*)"\s*>\s*<\/span>/.exec(template);
  if (found === null) throw new Error("no daisyUI loading element found in the progress panel");
  return found[1]!;
}

test("the phase that is running is drawn, not merely present", async ({ page }) => {
  const classes = await runningDotClasses();
  const built = await readFile(await builtStylesheet(), "utf8");
  const componentCss = await readFile(`${PANEL}.css`, "utf8");

  // Both inlined rather than linked: the built sheet declares its own
  // `@layer` blocks, so inlining keeps the cascade honest, and the component
  // sheet goes in second and unlayered — which is how Angular ships it.
  await page.setContent(`
    <style>${built}</style>
    <style>${componentCss}</style>
    <span class="phases__rail"><span id="dot" class="${classes}"></span></span>
  `);
  await page.waitForFunction(() =>
    getComputedStyle(document.getElementById("dot")!).maskImage !== "none");

  const painted = await page.$eval("#dot", (el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      background: style.backgroundColor,
      size: Math.round(box.width) * Math.round(box.height),
    };
  });

  // Transparent is the failure this exists for: the mask is set, the colour is
  // set, the box is the right size, and the user sees a hole where the run is.
  expect(painted.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(painted.background).not.toBe("transparent");
  expect(painted.size).toBeGreaterThan(0);
});
