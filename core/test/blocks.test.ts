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

describe("inline markup", () => {
  it("masks inline elements as numbered placeholders", () => {
    const { units } = extract({ source: doc("<p>A <em>bold</em> claim</p>"), doc: "c1.xhtml" });
    expect(units[0].source).toBe("A <0>bold</0> claim");
    expect(units[0].placeholders![0].open).toBe("<em>");
    expect(units[0].placeholders![0].close).toBe("</em>");
  });

  it("keeps an empty inline element as a self-contained placeholder", () => {
    const { units } = extract({ source: doc(`<p>Line<br/>break</p>`), doc: "c1.xhtml" });
    expect(units[0].source).toBe("Line<0/>break");
    expect(units[0].placeholders![0].close).toBe("");
  });

  it("keeps the content of an opaque element out of the translation", () => {
    const { units } = extract({ source: doc("<p>Run <code>ls -la</code> now</p>"), doc: "c1.xhtml" });
    expect(units[0].source).toBe("Run <0></0> now");
    expect(units[0].placeholders![0].opaque).toBe(true);
    expect(units[0].placeholders![0].rawContent).toBe("ls -la");
  });

  it("makes a translatable attribute its own unit, owned by the block", () => {
    const { units } = extract({ source: doc(`<p>See <img src="c.png" alt="A cat"/></p>`), doc: "c1.xhtml" });
    const attr = units.find((u) => u.kind === "attribute")!;
    expect(attr.source).toBe("A cat");
    expect(attr.owner).toBe("c1.xhtml#1");
    const ph = units[0].placeholders![0];
    expect(ph.attrs![0].unitId).toBe(attr.id);
    expect(ph.open.slice(ph.attrs![0].start, ph.attrs![0].end)).toBe("A cat");
  });
});

/**
 * A page marker records where a printed page began. It is not content, in any
 * state: translating "199" is meaningless, and listing it as an exclusion put
 * a second, mysterious row beside every code listing that carried one.
 *
 * The rule reads the element, never the value. An `aria-label` that is only a
 * number could be anything; a `doc-pagebreak` could not.
 */
describe("a page marker", () => {
  it("makes no unit of its own inside a listing", () => {
    const { units } = extract({
      doc: "c1.xhtml",
      source: `<html><body><pre><code><span aria-label="199" epub:type="pagebreak"`
        + ` id="pg_199" role="doc-pagebreak"/>const a = 1;</code></pre></body></html>`,
    });

    expect(units.map((unit) => unit.kind)).toEqual(["block"]);
    expect(units[0]!.state).toBe("code");
  });

  it("makes no unit in a paragraph either", () => {
    const { units } = extract({
      doc: "c1.xhtml",
      source: `<html><body><p><span aria-label="12" role="doc-pagebreak"/>A sentence.</p></body></html>`,
    });

    expect(units.filter((unit) => unit.kind === "attribute")).toEqual([]);
  });

  /** The rule is the marker's, not the attribute's: an ordinary label stays. */
  it("leaves an aria-label that labels something", () => {
    const { units } = extract({
      doc: "c1.xhtml",
      source: `<html><body><p><span aria-label="Home">A sentence.</span></p></body></html>`,
    });

    expect(units.filter((unit) => unit.kind === "attribute").map((unit) => unit.source))
      .toEqual(["Home"]);
  });
});

/**
 * The block's own element and class, not its first descendant's.
 *
 * A block's `raw` is its CONTENT, so reading a class out of it answers about
 * whatever is inside. The extractor has the node in hand and is the only place
 * that does.
 */
describe("what a unit says about its own markup", () => {
  it("carries the element and the first class of the block", () => {
    const { units } = extract({
      doc: "c1.xhtml",
      source: `<html><body><p class="TX first"><span class="mono">A sentence.</span></p></body></html>`,
    });

    expect(units[0]!.element).toBe("p");
    expect(units[0]!.className).toBe("TX");
  });

  it("says the element even when there is no class", () => {
    const { units } = extract({ doc: "c1.xhtml", source: "<html><body><pre>code</pre></body></html>" });
    expect(units[0]!.element).toBe("pre");
    expect(units[0]!.className).toBeUndefined();
  });

  /**
   * An attribute unit is not an element — the `img` it comes from is the
   * block's descendant, not the block. Task 8's label logic falls back to
   * `unit.kind` when `element` is absent, so inheriting the owning block's
   * element here would silently mislabel every attribute unit as a block.
   */
  it("gives an attribute unit neither element nor class, even though its owner has both", () => {
    const { units } = extract({
      doc: "c1.xhtml",
      source: `<html><body><p class="TX"><img src="c.png" alt="A cat"/></p></body></html>`,
    });

    const attr = units.find((u) => u.kind === "attribute")!;
    expect(attr.source).toBe("A cat");
    expect(attr.element).toBeUndefined();
    expect(attr.className).toBeUndefined();
  });

  /**
   * A loose-text run has no element of its own — it is bare text sitting
   * beside sibling blocks inside a container. Same fallback as the attribute
   * case: Task 8 reads `kind` when `element` is missing, so borrowing the
   * container's element would misreport this run as a block, too.
   */
  it("gives a loose-text unit neither element nor class, even though its container has one", () => {
    const { units } = extract({ source: doc("<div><p>One</p>Stray text<p>Two</p></div>"), doc: "c1.xhtml" });

    const textUnit = units.find((u) => u.kind === "text")!;
    expect(textUnit.source).toBe("Stray text");
    expect(textUnit.element).toBeUndefined();
    expect(textUnit.className).toBeUndefined();
  });
});
