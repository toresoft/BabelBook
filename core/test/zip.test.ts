import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { LIMITS, readEpub, writeEpub } from "../epub/zip.ts";
import { EpubReadError } from "../errors.ts";

describe("readEpub", () => {
  it("reads every entry and keeps the archive order", async () => {
    const bytes = await buildEpub({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    const epub = await readEpub(bytes);
    expect(epub.order[0]).toBe("mimetype");
    expect(epub.get("OEBPS/c1.xhtml")?.toString("utf8")).toContain("<p>Hi</p>");
  });

  it("refuses an entry whose name escapes the archive", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }],
      extra: [{ path: "../escape.txt", bytes: Buffer.from("nope") }],
    });
    await expect(readEpub(bytes)).rejects.toMatchObject({ code: "UNSAFE_ENTRY_NAME" });
  });

  it("refuses an archive with too many entries", async () => {
    const documents = Array.from({ length: LIMITS.maxEntries + 1 }, (_, i) => ({
      path: `OEBPS/c${i}.xhtml`,
      xhtml: "<p>x</p>",
    }));
    const bytes = await buildEpub({ documents });
    await expect(readEpub(bytes)).rejects.toBeInstanceOf(EpubReadError);
  });
});

describe("writeEpub", () => {
  it("round-trips an archive byte for byte through read and write", async () => {
    const bytes = await buildEpub({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    const first = await readEpub(bytes);
    const written = await writeEpub(first.entries);
    const second = await readEpub(written);
    expect(second.order).toEqual(first.order);
    for (const path of first.order) {
      expect(second.get(path)).toEqual(first.get(path));
    }
  });

  it("writes mimetype first and stored", async () => {
    const written = await writeEpub([
      { path: "OEBPS/c1.xhtml", bytes: Buffer.from("<p/>"), compress: true },
      { path: "mimetype", bytes: Buffer.from("application/epub+zip"), compress: false },
    ]);
    expect(written.subarray(30, 38).toString("ascii")).toBe("mimetype");
  });

  it("can write a non-conformant archive on purpose", async () => {
    const written = await writeEpub(
      [{ path: "OEBPS/c1.xhtml", bytes: Buffer.from("<p/>"), compress: true }],
      { conformant: false },
    );
    expect(written.subarray(30, 38).toString("ascii")).not.toBe("mimetype");
  });
});
