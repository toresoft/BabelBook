import { describe, expect, it } from "vitest";
import { extract } from "../epub/blocks.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>`
  + `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

describe("extract", () => {
  it("takes the innermost block as the unit, not its container", () => {
    const { units } = extract({ source: doc("<div><p>One</p><p>Two</p></div>"), doc: "c1.xhtml" });
    expect(units.map((u) => u.source)).toEqual(["One", "Two"]);
    expect(units.map((u) => u.id)).toEqual(["c1.xhtml#1", "c1.xhtml#2"]);
  });

  it("registers code blocks instead of dropping them, so ordinals do not shift", () => {
    const { units } = extract({ source: doc("<p>One</p><pre>x = 1</pre><p>Two</p>"), doc: "c1.xhtml" });
    expect(units.map((u) => u.state)).toEqual(["translate", "code", "translate"]);
    expect(units[2].id).toBe("c1.xhtml#3");
  });

  it("honours translate=no on the block and on an ancestor", () => {
    const { units } = extract({
      source: doc(`<p translate="no">Brand</p><div translate="no"><p>Also brand</p></div>`),
      doc: "c1.xhtml",
    });
    expect(units.map((u) => u.state)).toEqual(["translate-no", "translate-no"]);
  });

  it("never translates script and style", () => {
    const { units } = extract({ source: doc("<script>var a = 1;</script><p>Hi</p>"), doc: "c1.xhtml" });
    expect(units[0].state).toBe("never-translated");
  });

  it("in the navigation document the leaf is the anchor, not the list item", () => {
    const source = doc(`<nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter One</a></li></ol></nav>`);
    const { units } = extract({ source, doc: "nav.xhtml", nav: true });
    expect(units).toHaveLength(1);
    expect(units[0].source).toBe("Chapter One");
  });

  it("marks a block as code when the stylesheet says its class is a code surface", () => {
    const { units } = extract({
      source: doc(`<p class="listing">gem install foo</p>`),
      doc: "c1.xhtml",
      codeSurfaces: new Set(["listing"]),
    });
    expect(units[0].state).toBe("code");
    expect(units[0].reason).toBe("css-code-surface");
  });

  it("keeps the raw bytes of the range, not the decoded text", () => {
    const { units } = extract({ source: doc("<p>a &#38; b</p>"), doc: "c1.xhtml" });
    expect(units[0].source).toBe("a & b");
    expect(units[0].raw).toBe("a &#38; b");
  });
});
