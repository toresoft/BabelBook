import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, TWO_COLUMN_WIDTH } from "../shared/layout.ts";

const PROJECT_CSS = "app/renderer/src/app/project/project.css";

/**
 * The stylesheet is asked, not trusted from memory.
 *
 * The width at which the book's column leaves the side of the work is written
 * in a media query, and the window's floor is written in TypeScript. Nothing
 * makes the two agree except this test: move the breakpoint up and the floor
 * stops clearing it, and the user can drag the window to a width where the
 * right column drops under the list — which is the state the floor exists to
 * forbid.
 */
async function breakpointPx(): Promise<number> {
  const css = await readFile(PROJECT_CSS, "utf8");
  const found = /@media\s*\(max-width:\s*([\d.]+)rem\)/.exec(css);
  if (found === null) throw new Error(`no rem breakpoint in ${PROJECT_CSS}`);
  return Number(found[1]) * 16;
}

describe("the window's floor", () => {
  it("names the width at which the project screen gives up its second column", async () => {
    expect(TWO_COLUMN_WIDTH).toBe(await breakpointPx());
  });

  /**
   * Strictly above, and with room to spare: `BrowserWindow`'s width counts the
   * frame the platform draws around it, while the media query measures only
   * the page inside. A floor set exactly at the breakpoint would leave a
   * window whose viewport is a dozen pixels short of it.
   */
  it("stands clear of it, by more than any window frame is wide", async () => {
    expect(MIN_WINDOW_WIDTH).toBeGreaterThan(await breakpointPx() + 32);
  });

  /** The right column scrolls, so height cannot collapse it — but a window
      shorter than this shows header and buttons and nothing else. */
  it("keeps a floor under the height as well", () => {
    expect(MIN_WINDOW_HEIGHT).toBeGreaterThanOrEqual(600);
  });
});
