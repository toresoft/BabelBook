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
 * What survives the change of foundation.
 *
 * daisyUI supplies the shape of the controls, so the rules that used to hold
 * one padding and one radius have nothing left to hold. Two things do survive,
 * because they are decisions rather than implementation: every colour comes
 * from one place, and the cursor stays the arrow.
 */
describe("the stylesheets", () => {
  it("keep every colour in the global sheet, where the themes are", async () => {
    const files = (await cssFiles("app/renderer/src")).filter((path) => path !== STYLES);

    const offenders: string[] = [];
    for (const path of files) {
      const css = await readFile(path, "utf8");
      for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never point the cursor on a button: the arrow, like a native application", async () => {
    const offenders: string[] = [];
    for (const path of await cssFiles("app/renderer/src")) {
      if ((await readFile(path, "utf8")).includes("cursor: pointer")) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it("gives the window a background that matches the theme it opens in", async () => {
    const source = await readFile("app/main/window.ts", "utf8");

    // A white flash before the renderer paints is the window's own background
    // showing through: it must be the theme's colour, decided by nativeTheme.
    expect(source).toContain("backgroundColor");
    expect(source).toContain("nativeTheme");
  });
});
