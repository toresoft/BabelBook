import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { inspect } from "../epub/inspect.ts";
import { checkInvariants } from "../epub/invariants.ts";

async function model(spec: Parameters<typeof buildEpub>[0]) {
  return inspect((await readEpub(await buildEpub(spec))).entries);
}

const base = { documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi</p>` }], language: "en" };

describe("checkInvariants", () => {
  it("passes when the book is compared with itself", async () => {
    const m = await model(base);
    const results = checkInvariants({
      before: m, after: m, units: [], distrusted: 0, skippedDocs: [],
      targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
    });
    expect(results.filter((r) => !r.ok && !r.skipped)).toEqual([]);
    expect(results.map((r) => r.id)).toContain("I22");
  });

  it("declares an invariant skipped instead of faking a pass", async () => {
    const m = await model(base);
    const results = checkInvariants({
      before: m, after: m, units: [], distrusted: 0, skippedDocs: [],
      targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
    });
    expect(results.find((r) => r.id === "I11")?.skipped).toBe(true);
  });

  it("fails I8 when the unique identifier changed", async () => {
    const before = await model(base);
    const after = await model({ ...base, identifier: "urn:uuid:99999999-9999-9999-9999-999999999999" });
    const results = checkInvariants({
      before, after, units: [], distrusted: 0, skippedDocs: [],
      targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
    });
    expect(results.find((r) => r.id === "I8")?.ok).toBe(false);
  });

  it("fails I15 when a unit was discarded for an unreliable range", async () => {
    const m = await model(base);
    const results = checkInvariants({
      before: m, after: m, units: [], distrusted: 2, skippedDocs: [],
      targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
    });
    expect(results.find((r) => r.id === "I15")?.ok).toBe(false);
  });
});
