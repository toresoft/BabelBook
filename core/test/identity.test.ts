import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import {
  archiveCodeSurfaces, buildSkeleton, extract, fillSkeleton,
  findPackagePath, inspect, readEpub, readPackage, writeEpub,
} from "../epub/index.ts";

const FIXTURES = [
  { name: "prose", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two &#38; three</p>" }] },
  { name: "inline", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>A <em>bold</em> <code>ls -la</code> claim</p>" }] },
  { name: "attributes", documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p>See <img src="c.png" alt="A cat" title="Cat"/></p>` }] },
  { name: "entities", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>&copy; 2026 &hellip; &#8212;</p>" }] },
  { name: "nested-blocks", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<div><blockquote><p>Deep</p></blockquote>loose text</div>" }] },
  { name: "machinery", documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<style>p { color: red }</style><p>Plate</p><div><script>var a = 1;</script>Loose</div>` }] },
  { name: "table", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<table><tr><td>Cell</td><th>Head</th></tr></table>" }] },
  { name: "translate-no", documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p translate="no">Brand</p><p>Text</p>` }] },
  { name: "pre-paginated", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Plate</p>", layout: "pre-paginated" as const }] },
  { name: "two-documents", documents: [
    { path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" },
    { path: "OEBPS/c2.xhtml", xhtml: "<p>Two</p>" },
  ] },
];

describe("identity", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    "%s: an empty fill returns every document byte for byte",
    async (_name, fixture) => {
      const epub = await readEpub(await buildEpub(fixture));
      const surfaces = archiveCodeSurfaces(epub.entries);
      const pkg = readPackage(epub.entries);

      for (const item of pkg.manifest.filter((m) => m.mediaType === "application/xhtml+xml")) {
        const path = item.href.includes("/") ? item.href : `OEBPS/${item.href}`;
        const source = epub.get(path)!.toString("utf8");
        const { units } = extract({ source, doc: path, codeSurfaces: surfaces, nav: path.endsWith("nav.xhtml") });
        const skeleton = buildSkeleton(source, units);
        expect(fillSkeleton(skeleton, units, new Map()).text).toBe(source);
      }
    },
  );

  it("rewrites nothing in the archive when nothing is translated", async () => {
    const epub = await readEpub(await buildEpub(FIXTURES[0]));
    const before = inspect(epub.entries);
    const written = await writeEpub(epub.entries);
    const after = inspect((await readEpub(written)).entries);
    expect(after.resourcePaths).toEqual(before.resourcePaths);
    expect(after.binaryHashes).toEqual(before.binaryHashes);
    expect(findPackagePath(epub.entries)).toBe(before.opfPath);
  });
});
