import { resolveHref } from "./package.ts";
import { scan } from "./scan.ts";
import type { ZipEntry } from "./zip.ts";

export interface OverlayRemoval {
  /** the archive without the SMIL files and without the orphaned audio */
  entries: ZipEntry[];
  /** the cleaned OPF */
  opf: string;
  removed: { overlays: number; audio: number };
}

const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".oga", ".opus", ".wav", ".mp4"];
const DOCUMENT_EXTENSIONS = [".xhtml", ".html", ".htm"];

function hasExtension(path: string, extensions: string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at + 1);
}

/** The archive path an href names, or "" when it names nothing in the archive. */
function resolve(base: string, href: string): string {
  const { path } = resolveHref(base, href);
  return path === base ? "" : path;
}

export function hasOverlays(entries: ZipEntry[]): boolean {
  if (entries.some((e) => e.path.toLowerCase().endsWith(".smil"))) return true;
  return entries.some(
    (e) => e.path.toLowerCase().endsWith(".opf") && e.bytes.toString("utf8").includes("media-overlay"),
  );
}

/** Every archive path a content document points at on its own. */
function referencedByContent(entries: ZipEntry[]): Set<string> {
  const referenced = new Set<string>();
  for (const entry of entries) {
    if (!hasExtension(entry.path, DOCUMENT_EXTENSIONS)) continue;
    let events;
    try {
      events = scan(entry.bytes.toString("utf8"), entry.path);
    } catch {
      continue;
    }
    for (const event of events) {
      if (event.kind !== "opentag") continue;
      for (const attr of event.attrs ?? []) {
        if (attr.name !== "src" && attr.name !== "href" && attr.name !== "xlink:href") continue;
        const path = resolve(entry.path, attr.value);
        if (path !== "") referenced.add(path);
      }
    }
  }
  return referenced;
}

function dropManifestItems(opf: string, opfDir: string, dropped: Set<string>): string {
  return opf.replace(/[ \t]*<item\b[^>]*\/>\r?\n?/g, (whole) => {
    const href = /\shref\s*=\s*(["'])(.*?)\1/.exec(whole);
    if (!href) return whole;
    return dropped.has(resolve(`${opfDir}x`, href[2])) ? "" : whole;
  });
}

/**
 * Removes the media overlays whole, or not at all.
 *
 * Source-language audio under a translated text serves nobody, and dragging it
 * along means carrying tens or hundreds of unusable megabytes. Five points move
 * together: the SMIL items and files, the `media-overlay` attributes, the
 * `media:*` metadata, the audio nothing references any more, and — untouched —
 * the element ids. Those ids were the overlays' target, but they are also the
 * target of the internal links: removing them would break navigation.
 *
 * A half-done removal is worse than none: EPUBCheck refuses a `media-overlay`
 * pointing at an item that is not there, and an orphaned `media:duration`
 * raises MED-016.
 */
export function removeOverlays(entries: ZipEntry[], opfPath: string): OverlayRemoval {
  const opfEntry = entries.find((e) => e.path === opfPath);
  const original = opfEntry ? opfEntry.bytes.toString("utf8") : "";

  const smil = entries.filter((e) => e.path.toLowerCase().endsWith(".smil"));
  if (smil.length === 0 && !original.includes("media-overlay") && !original.includes("media:")) {
    return { entries, opf: original, removed: { overlays: 0, audio: 0 } };
  }

  // The SMIL files go first, so their own references stop counting when the
  // orphaned audio is worked out.
  const withoutSmil = entries.filter((e) => !e.path.toLowerCase().endsWith(".smil"));
  const referenced = referencedByContent(withoutSmil);

  const orphanedAudio = new Set(
    withoutSmil
      .filter((e) => hasExtension(e.path, AUDIO_EXTENSIONS) && !referenced.has(e.path))
      .map((e) => e.path),
  );

  const dropped = new Set([...smil.map((e) => e.path), ...orphanedAudio]);
  const opfDir = directoryOf(opfPath);

  let opf = dropManifestItems(original, opfDir, dropped);
  opf = opf.replace(/\s+media-overlay\s*=\s*(["']).*?\1/g, "");
  opf = opf.replace(
    /[ \t]*<meta\b[^>]*property\s*=\s*(["'])media:[^"']*\1[^>]*>[\s\S]*?<\/meta>\r?\n?/g,
    "",
  );
  opf = opf.replace(/[ \t]*<meta\b[^>]*property\s*=\s*(["'])media:[^"']*\1[^>]*\/>\r?\n?/g, "");

  const kept = withoutSmil
    .filter((e) => !orphanedAudio.has(e.path))
    .map((e) => (e.path === opfPath ? { ...e, bytes: Buffer.from(opf, "utf8") } : e));

  return {
    entries: kept,
    opf,
    removed: { overlays: smil.length, audio: orphanedAudio.size },
  };
}
