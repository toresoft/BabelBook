import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { readPackage, writeLanguage, writeRootLang } from "../epub/package.ts";

describe("readPackage", () => {
  it("reads identifier, language, manifest and spine", async () => {
    const bytes = await buildEpub({
      language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }],
    });
    const pkg = readPackage((await readEpub(bytes)).entries);
    expect(pkg.language).toBe("en");
    expect(pkg.uniqueIdentifier).toBe("urn:uuid:11111111-2222-3333-4444-555555555555");
    expect(pkg.spine.length).toBeGreaterThan(0);
  });
});

describe("writeLanguage", () => {
  it("rewrites dc:language and dcterms:modified, and leaves the identifier alone", async () => {
    const bytes = await buildEpub({ language: "en", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    const pkg = readPackage((await readEpub(bytes)).entries);
    const out = writeLanguage(pkg.source, "it", new Date("2026-08-24T10:00:00Z"));
    expect(out).toContain("<dc:language>it</dc:language>");
    expect(out).toContain("2026-08-24T10:00:00Z");
    expect(out).toContain(pkg.uniqueIdentifier);
  });
});

describe("writeRootLang", () => {
  it("rewrites a regional tag whose primary subtag matches the source language", () => {
    const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en-US" lang="en-US"><body/></html>`;
    const out = writeRootLang(xhtml, "it");
    expect(out).toContain(`xml:lang="it"`);
    expect(out).toContain(`lang="it"`);
  });
});
