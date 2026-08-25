import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findJar, introducedMessages, runEpubcheck } from "../epub/epubcheck.ts";

describe("findJar", () => {
  /**
   * The jar has to exist for this one. The plan wrote both cases against paths
   * that are absent, which no implementation can tell apart: the same call
   * would have to answer with the path and with null.
   */
  it("prefers the jar the environment names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babelbook-"));
    const jar = join(dir, "ec.jar");
    await writeFile(jar, "not really a jar");
    expect(findJar({ EPUBCHECK_JAR: jar }, "/work")).toBe(jar);
  });

  it("returns null when the named jar is absent, without falling back", () => {
    expect(findJar({ EPUBCHECK_JAR: "/nope/missing.jar" }, "/work")).toBeNull();
  });
});

describe("runEpubcheck", () => {
  it("says it did not run instead of pretending it passed", async () => {
    const result = await runEpubcheck("/tmp/whatever.epub", { EPUBCHECK_JAR: "/nope/missing.jar" });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("no-jar");
    expect(result.messages).toEqual([]);
  });
});

describe("introducedMessages", () => {
  it("blames only what the run introduced", () => {
    const before = { ran: true, messages: [{ id: "RSC-005", severity: "error" as const, message: "old" }] };
    const after = {
      ran: true,
      messages: [
        { id: "RSC-005", severity: "error" as const, message: "old" },
        { id: "MED-016", severity: "error" as const, message: "new" },
      ],
    };
    expect(introducedMessages(before, after).map((m) => m.id)).toEqual(["MED-016"]);
  });
});
