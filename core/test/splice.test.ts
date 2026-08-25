import { describe, expect, it } from "vitest";
import { extract } from "../epub/blocks.ts";
import { render } from "../epub/splice.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>`
  + `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

describe("render", () => {
  it("puts the original tags back where the placeholders are", () => {
    const { units } = extract({ source: doc("<p>A <em>bold</em> claim</p>"), doc: "c1.xhtml" });
    expect(render(units[0], "Una <0>audace</0> affermazione")).toBe("Una <em>audace</em> affermazione");
  });

  it("re-emits opaque content from the raw source, not from the decoded text", () => {
    const { units } = extract({ source: doc("<p>Run <code>a &#38; b</code> now</p>"), doc: "c1.xhtml" });
    expect(render(units[0], "Esegui <0></0> ora")).toBe("Esegui <code>a &#38; b</code> ora");
  });

  it("splices a translated attribute into its recorded offsets", () => {
    const { units } = extract({ source: doc(`<p>See <img src="c.png" alt="A cat"/></p>`), doc: "c1.xhtml" });
    const attr = units.find((u) => u.kind === "attribute")!;
    const out = render(units[0], "Vedi <0/>", new Map([[attr.id, "Un gatto"]]));
    expect(out).toBe(`Vedi <img src="c.png" alt="Un gatto"/>`);
  });

  it("refuses a translation that names a placeholder the unit does not have", () => {
    const { units } = extract({ source: doc("<p>Plain</p>"), doc: "c1.xhtml" });
    expect(() => render(units[0], "Testo <7>ignoto</7>")).toThrow();
  });
});
