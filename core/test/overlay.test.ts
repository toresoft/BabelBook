import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { findPackagePath } from "../epub/package.ts";
import { hasOverlays, removeOverlays } from "../epub/overlay.ts";

async function withOverlay() {
  const bytes = await buildEpub({
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi</p>` }],
    overlays: [{
      smilPath: "OEBPS/c1.smil", audioPath: "OEBPS/c1.mp3",
      forDocument: "OEBPS/c1.xhtml", duration: "0:00:05",
    }],
  });
  const epub = await readEpub(bytes);
  return { epub, opfPath: findPackagePath(epub.entries) };
}

describe("removeOverlays", () => {
  it("finds the overlays before removing them", async () => {
    const { epub } = await withOverlay();
    expect(hasOverlays(epub.entries)).toBe(true);
  });

  it("removes smil files, the media-overlay attribute and the media metadata", async () => {
    const { epub, opfPath } = await withOverlay();
    const out = removeOverlays(epub.entries, opfPath);
    expect(out.entries.some((e) => e.path.endsWith(".smil"))).toBe(false);
    expect(out.opf).not.toContain("media-overlay");
    expect(out.opf).not.toContain("media:duration");
    expect(out.opf).not.toContain("media:narrator");
    expect(out.removed).toEqual({ overlays: 1, audio: 1 });
  });

  it("keeps the element ids the overlays pointed at", async () => {
    const { epub, opfPath } = await withOverlay();
    const out = removeOverlays(epub.entries, opfPath);
    const c1 = out.entries.find((e) => e.path === "OEBPS/c1.xhtml")!;
    expect(c1.bytes.toString("utf8")).toContain(`id="p1"`);
  });

  it("keeps audio a content document references on its own", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi</p><audio src="song.mp3"/>` }],
      extra: [{ path: "OEBPS/song.mp3", bytes: Buffer.from("fake") }],
      overlays: [{
        smilPath: "OEBPS/c1.smil", audioPath: "OEBPS/c1.mp3",
        forDocument: "OEBPS/c1.xhtml", duration: "0:00:05",
      }],
    });
    const epub = await readEpub(bytes);
    const out = removeOverlays(epub.entries, findPackagePath(epub.entries));
    expect(out.entries.some((e) => e.path === "OEBPS/song.mp3")).toBe(true);
    expect(out.removed.audio).toBe(1);
  });

  it("leaves an archive without overlays exactly as it was", async () => {
    const bytes = await buildEpub({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    const epub = await readEpub(bytes);
    const out = removeOverlays(epub.entries, findPackagePath(epub.entries));
    expect(out.entries).toEqual(epub.entries);
    expect(out.removed).toEqual({ overlays: 0, audio: 0 });
  });
});
