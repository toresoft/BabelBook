import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { readPackage } from "../epub/package.ts";
import { detectLayout } from "../epub/layout.ts";

async function layoutOf(spec: Parameters<typeof buildEpub>[0]) {
  const epub = await readEpub(await buildEpub(spec));
  return detectLayout(readPackage(epub.entries));
}

describe("detectLayout", () => {
  it("calls a book reflowable when nothing says otherwise", async () => {
    const report = await layoutOf({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    expect(report.book).toBe("reflowable");
    expect(report.prePaginated).toBe(0);
  });

  it("reads the package-level property", async () => {
    const report = await layoutOf({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }],
      packageProperties: `<meta property="rendition:layout">pre-paginated</meta>`,
    });
    expect(report.book).toBe("pre-paginated");
    expect(report.prePaginated).toBe(1);
  });

  it("lets a spine item override the package", async () => {
    const report = await layoutOf({
      documents: [
        { path: "OEBPS/c1.xhtml", xhtml: "<p>Text</p>" },
        { path: "OEBPS/plate.xhtml", xhtml: "<p>Plate</p>", layout: "pre-paginated" },
      ],
    });
    expect(report.book).toBe("mixed");
    expect(report.byDocument["OEBPS/plate.xhtml"]).toBe("pre-paginated");
    expect(report.prePaginated).toBe(1);
  });
});
