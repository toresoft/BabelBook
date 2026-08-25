import { describe, expect, it } from "vitest";
import { extract } from "../epub/blocks.ts";
import { buildSkeleton, fillSkeleton, SkeletonError } from "../epub/skeleton.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>`
  + `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

describe("skeleton", () => {
  it("returns the source byte for byte when nothing is translated", () => {
    const source = doc("<p>One &#38; two</p><pre>x = 1</pre>");
    const { units } = extract({ source, doc: "c1.xhtml" });
    const skeleton = buildSkeleton(source, units);
    const { text, filled } = fillSkeleton(skeleton, units, new Map());
    expect(text).toBe(source);
    expect(filled).toBe(0);
  });

  it("leaves no delimiter behind after a fill", () => {
    const source = doc("<p>One</p>");
    const { units } = extract({ source, doc: "c1.xhtml" });
    const skeleton = buildSkeleton(source, units);
    const { text } = fillSkeleton(skeleton, units, new Map([[units[0].id, "Uno"]]));
    expect(text).not.toContain(skeleton.open);
    expect(text).not.toContain(skeleton.close);
    expect(text).toContain("<p>Uno</p>");
  });

  it("picks a delimiter that does not occur in the source", () => {
    const source = doc("<p>A ⟦u: literal ⟧ in the text</p>");
    const { units } = extract({ source, doc: "c1.xhtml" });
    const skeleton = buildSkeleton(source, units);
    expect(skeleton.open).not.toBe("⟦u:");
  });

  it("refuses units whose ranges do not describe this source", () => {
    const source = doc("<p>One</p>");
    const { units } = extract({ source, doc: "c1.xhtml" });
    const stale = units.map((u) => ({ ...u, range: [9_000, 9_100] as [number, number] }));
    expect(() => buildSkeleton(source, stale)).toThrow(SkeletonError);
  });
});
