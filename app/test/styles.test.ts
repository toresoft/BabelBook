import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = "app/renderer/src/styles.css";

async function cssFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await cssFiles(path)));
    else if (entry.name.endsWith(".css")) out.push(path);
  }
  return out;
}

/**
 * The net under the foundations.
 *
 * The application's look rests on one stylesheet: the font, the colour scheme
 * and every colour the screens share live there, so the theme is changed in
 * one place or not at all. These tests hold that floor — without the last one,
 * the first new component quietly puts a hexadecimal colour of its own in and
 * the palette forks.
 */
describe("the foundations", () => {
  it("adopts the system font, which is the application's font", async () => {
    const css = await readFile(STYLES, "utf8");
    expect(css).toMatch(/font-family:\s*system-ui/);
  });

  it("declares both colour schemes, so native controls follow the theme", async () => {
    const css = await readFile(STYLES, "utf8");
    expect(css).toContain("color-scheme: light dark");
  });

  it("defines the colours as variables and redefines them for the dark theme", async () => {
    const css = await readFile(STYLES, "utf8");
    expect(css).toMatch(/:root\s*\{[^}]*--/);

    const dark = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*)\}/);
    expect(dark).not.toBeNull();
    expect(dark?.[1]).toMatch(/--[a-z-]+:/);
  });

  it("gives the window a background that matches the theme it opens in", async () => {
    const source = await readFile("app/main/window.ts", "utf8");

    // A white flash before the renderer paints is the window's own background
    // showing through: it must be the theme's colour, decided by nativeTheme.
    expect(source).toContain("backgroundColor");
    expect(source).toContain("nativeTheme");
  });
});

describe("the component stylesheets", () => {
  it("carry no hexadecimal colour of their own", async () => {
    const files = (await cssFiles("app/renderer/src")).filter((path) => path !== STYLES);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const path of files) {
      const css = await readFile(path, "utf8");
      for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * The controls, as rules rather than per-component handiwork.
 *
 * A primary, a secondary and a destructive button must be tellable apart in a
 * single glance, which only holds when each is one class in the global sheet
 * rather than a colour someone wrote next to the button that needed it.
 */
describe("the controls", () => {
  it("distinguishes primary, secondary and destructive buttons by their own rules", async () => {
    const css = await readFile(STYLES, "utf8");

    expect(css).toMatch(/\.btn\s*\{/);
    expect(css).toMatch(/\.btn--primary\s*\{[^}]*var\(--accent\)/);
    expect(css).toMatch(/\.btn--danger\s*\{[^}]*var\(--danger\)/);
  });

  it("gives fields and selects one height and one radius", async () => {
    const css = await readFile(STYLES, "utf8");

    const shared = css.match(/input[^{]*,\s*select[^{]*,\s*textarea\s*\{([^}]*)\}/);
    expect(shared).not.toBeNull();
    expect(shared?.[1]).toMatch(/padding/);
    expect(shared?.[1]).toMatch(/border-radius/);
  });

  it("sizes no field in its component: no padding of its own on inputs and selects", async () => {
    const files = (await cssFiles("app/renderer/src")).filter((path) => path !== STYLES);
    const offenders: string[] = [];

    for (const path of files) {
      const css = await readFile(path, "utf8");
      for (const match of css.matchAll(/([^{}]*?(?:input|select|search)[^{}]*)\{([^}]*)\}/g)) {
        if (/padding|border-radius/.test(match[2])) offenders.push(`${path}: ${match[1].trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never points the cursor on a button: the arrow, like a native application", async () => {
    const files = await cssFiles("app/renderer/src");
    const offenders = [];

    for (const path of files) {
      const css = await readFile(path, "utf8");
      if (css.includes("cursor: pointer")) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });
});
