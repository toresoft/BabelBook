import { describe, expect, it } from "vitest";
import { archiveCodeSurfaces } from "../epub/css.ts";

const css = (text: string) => [
  { path: "OEBPS/style.css", bytes: Buffer.from(text, "utf8"), compress: true },
];

describe("archiveCodeSurfaces", () => {
  it("takes a class whose font is monospace", () => {
    expect(archiveCodeSurfaces(css(".listing { font-family: monospace; }"))).toContain("listing");
  });

  it("takes a class whose font family names a known monospace face", () => {
    expect(archiveCodeSurfaces(css(".cmd { font-family: 'Courier New', monospace; }"))).toContain("cmd");
  });

  it("ignores a class that merely preserves whitespace", () => {
    expect(archiveCodeSurfaces(css(".poem { white-space: pre; }"))).not.toContain("poem");
  });

  it("ignores css it cannot parse instead of throwing", () => {
    expect(() => archiveCodeSurfaces(css(".broken { font-family"))).not.toThrow();
  });
});
