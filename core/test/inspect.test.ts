import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { inspect } from "../epub/inspect.ts";

describe("inspect", () => {
  it("describes the book without using the scanner the pipeline transforms with", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi <a href="c2.xhtml">there</a></p>` }],
    });
    const model = inspect((await readEpub(bytes)).entries);
    expect(model.elementIds["OEBPS/c1.xhtml"]).toEqual(["p1"]);
    expect(model.internalLinks).toContainEqual({ from: "OEBPS/c1.xhtml", href: "c2.xhtml" });
    expect(model.mimetypeConformant).toBe(true);
    expect(model.nav.length).toBeGreaterThan(0);
  });

  it("does not import the pipeline scanner", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const text = await readFile(join(import.meta.dirname, "..", "epub", "inspect.ts"), "utf8");
    expect(text).not.toContain("./scan.ts");
    expect(text).not.toContain("saxes");
  });
});
