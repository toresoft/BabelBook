import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { inspect } from "../epub/inspect.ts";
import { extract } from "../epub/blocks.ts";
import { checkInvariants } from "../epub/invariants.ts";
import { SABOTAGES } from "./corpus/sabotage.ts";

describe("sabotages", () => {
  it.each(SABOTAGES.map((s) => [s.name, s] as const))(
    "%s trips the invariants it claims to trip",
    async (_name, sabotage) => {
      const bytes = await buildEpub({
        documents: [{
          path: "OEBPS/c1.xhtml",
          xhtml: `<p id="p1">A <em>bold</em> claim with <code>ls</code> and <img src="c.png" alt="A cat"/></p>`,
        }],
      });
      const epub = await readEpub(bytes);
      const before = inspect(epub.entries);
      const source = epub.get("OEBPS/c1.xhtml")!.toString("utf8");
      const { units } = extract({ source, doc: "OEBPS/c1.xhtml" });

      const damaged = await sabotage.apply(epub.entries, units);
      const results = checkInvariants({
        before, after: inspect(damaged), units, distrusted: 0, skippedDocs: [],
        targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
      });

      // Every claimed invariant, not merely one of them: a claim the corpus
      // cannot reach is a wish, and it belongs out of the list rather than
      // hidden behind a laxer assertion.
      const failed = results.filter((r) => !r.ok).map((r) => r.id);
      expect(sabotage.trips.filter((id) => !failed.includes(id))).toEqual([]);
    },
  );

  it("is a suite that has been shown it can fail", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi</p>` }],
    });
    const epub = await readEpub(bytes);
    const model = inspect(epub.entries);
    const results = checkInvariants({
      before: model, after: model, units: [], distrusted: 0, skippedDocs: [],
      targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(SABOTAGES).toHaveLength(12);
  });
});
