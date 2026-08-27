import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const STYLES = "app/renderer/src/styles.css";

/**
 * The foundation, after daisyUI.
 *
 * The palette is no longer a list of names this application invented: it is
 * daisyUI's, filled with this application's values. These tests hold the two
 * things that would silently break — the plugin being loaded at all, and the
 * theme being chosen by the attribute the main process actually sets.
 */
describe("the foundation", () => {
  it("loads tailwind and daisyui, and declares both themes", async () => {
    const css = await readFile(STYLES, "utf8");

    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain('@plugin "daisyui"');
    expect(css).toMatch(/name:\s*"babelbook"/);
    expect(css).toMatch(/name:\s*"babelbook-dark"/);
  });

  it("keeps the palette it had, so this change is one change", async () => {
    const css = await readFile(STYLES, "utf8");

    // The values are the ones the application shipped before daisyUI. A screen
    // that comes back a different colour means the port changed two things at
    // once, and the screenshots stop being reviewable.
    expect(css).toContain("#2563eb"); // accent, light
    expect(css).toContain("#0f172a"); // surface, dark
    expect(css).toContain("#b91c1c"); // danger, light
  });
});
