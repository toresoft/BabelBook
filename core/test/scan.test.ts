import { describe, expect, it } from "vitest";
import { decodeEntities, escapeAttr, escapeText, scan } from "../epub/scan.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>`
  + `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

describe("scan", () => {
  it("reports a text range that slices back to the same bytes", () => {
    const source = doc("<p>Hello</p>");
    const text = scan(source, "c1.xhtml").find((e) => e.kind === "text" && e.text === "Hello");
    expect(text).toBeDefined();
    expect(source.slice(text!.rawStart, text!.rawEnd)).toBe("Hello");
  });

  it("keeps an entity inside a single text event and decodes it", () => {
    const source = doc("<p>a &amp; b</p>");
    const text = scan(source, "c1.xhtml").find((e) => e.kind === "text" && e.text?.includes("&"));
    expect(text!.text).toBe("a & b");
    expect(source.slice(text!.rawStart, text!.rawEnd)).toBe("a &amp; b");
  });

  it("parses an XHTML 1.0 named entity that plain XML does not know", () => {
    const source = doc("<p>&copy; 2026 &hellip;</p>");
    const events = scan(source, "c1.xhtml");
    const text = events.find((e) => e.kind === "text");
    expect(text!.text).toBe("© 2026 …");
    expect(text!.reliable).toBe(true);
  });

  it("reports attribute value offsets relative to the opening tag", () => {
    const source = doc(`<img src="x.png" alt="A cat"/>`);
    const open = scan(source, "c1.xhtml").find((e) => e.kind === "opentag" && e.name === "img");
    const alt = open!.attrs!.find((a) => a.name === "alt")!;
    const tag = source.slice(open!.rawStart, open!.rawEnd);
    expect(tag.slice(alt.start, alt.end)).toBe("A cat");
  });
});

describe("escaping", () => {
  it("round-trips through decode after escape", () => {
    expect(decodeEntities(escapeText("a & b < c"))).toBe("a & b < c");
    expect(escapeAttr('say "hi"')).toContain("&quot;");
  });
});
