import { describe, expect, it } from "vitest";
import { displayText } from "../main/units/display.ts";

/**
 * What the two tabs that list units are meant to show.
 *
 * `source_text` is masked: a `<pre><code>…</code></pre>` collapses to the
 * placeholder `<0></0>` and reads as an empty row. On a real technical book
 * that was every single code listing — a wall of identical blanks, which is
 * what "the discovery got worse" turned out to mean.
 *
 * `raw_text` holds the bytes, and the bytes are the answer. They carry markup
 * and entities, so they are stripped and decoded here, never interpreted:
 * this is text for a person to read, not HTML for a browser to run.
 */
describe("the text a unit is shown as", () => {
  it("is the code itself, not the placeholder that masks it", () => {
    expect(displayText("<code>const a = 1;</code>", "<0></0>")).toBe("const a = 1;");
  });

  it("decodes the entities the bytes carry", () => {
    expect(displayText("<code>if (a &lt; b) {}</code>", "<0></0>")).toBe("if (a < b) {}");
  });

  it("keeps the line breaks of a listing", () => {
    expect(displayText("<code>one\r\ntwo</code>", "<0></0>")).toBe("one\ntwo");
  });

  /** A row written before `raw_text` existed still has to show something. */
  it("falls back to the masked source when there are no bytes", () => {
    expect(displayText(null, "A sentence.")).toBe("A sentence.");
  });

  /** The page marker's own tag is markup, and leaves nothing behind. */
  it("drops a self-closing marker without leaving a gap", () => {
    expect(displayText(`<code><span aria-label="199" epub:type="pagebreak"/>const a = 1;</code>`, "<0></0>"))
      .toBe("const a = 1;");
  });
});
