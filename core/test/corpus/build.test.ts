import { describe, expect, it } from "vitest";
import { fromBuffer } from "yauzl-promise";
import { buildEpub } from "./build.ts";

describe("buildEpub", () => {
  it("writes mimetype first, stored, with the exact media type", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hello</p>" }],
    });
    expect(bytes.subarray(30, 38).toString("ascii")).toBe("mimetype");
    expect(bytes.subarray(38, 58).toString("ascii")).toBe("application/epub+zip");
  });

  it("declares every document in manifest and spine", async () => {
    const bytes = await buildEpub({
      documents: [
        { path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" },
        { path: "OEBPS/c2.xhtml", xhtml: "<p>Two</p>" },
      ],
    });
    const zip = await fromBuffer(bytes);
    const names: string[] = [];
    for await (const entry of zip) names.push(entry.filename);
    await zip.close();
    expect(names).toContain("OEBPS/content.opf");
    expect(names).toContain("OEBPS/c2.xhtml");
    const opf = names.includes("OEBPS/c1.xhtml");
    expect(opf).toBe(true);
  });

  /**
   * `yazl` refuses a name that escapes the archive, so the builder has to write
   * one behind its back. Without this the reader has no way to be shown the
   * defect it is supposed to refuse.
   */
  it("can write an entry name the zip writer would otherwise refuse", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
      extra: [{ path: "../escape.txt", bytes: Buffer.from("nope") }],
    });
    const zip = await fromBuffer(bytes, { validateFilenames: false });
    const names: string[] = [];
    for await (const entry of zip) names.push(entry.filename);
    await zip.close();
    expect(names).toContain("../escape.txt");
  });
});
