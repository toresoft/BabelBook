import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

/**
 * The build is part of this test, not a precondition of it.
 *
 * Asserting on `dist/` without building only reports whether someone happened
 * to build recently: it passes on a developer's machine and fails on a fresh
 * clone, which is the wrong way round.
 */
describe("build output", () => {
  beforeAll(async () => {
    await run("npm", ["run", "build", "-w", "app"], { cwd: process.cwd() });
  }, 300_000);

  it("produces the three bundles the app needs", () => {
    expect(existsSync("app/dist/main/main.js")).toBe(true);
    expect(existsSync("app/dist/preload/preload.js")).toBe(true);
    expect(existsSync("app/dist/renderer/index.html")).toBe(true);
  });
});
