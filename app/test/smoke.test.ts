import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("build output", () => {
  it("produces the three bundles the app needs", () => {
    expect(existsSync("app/dist/main/main.js")).toBe(true);
    expect(existsSync("app/dist/preload/preload.js")).toBe(true);
    expect(existsSync("app/dist/renderer/index.html")).toBe(true);
  });
});
