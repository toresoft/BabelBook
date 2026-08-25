import { EpubReadError } from "./errors.ts";
import { decodeEntities, escapeText, scan, type ScanEvent } from "./scan.ts";
import type { ZipEntry } from "./zip.ts";

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties?: string;
  mediaOverlay?: string;
}

export interface SpineItem {
  idref: string;
  linear: boolean;
  properties?: string;
}

export interface PackageDoc {
  /** the OPF's path in the archive */
  path: string;
  /** the dc:identifier named by unique-identifier */
  uniqueIdentifier: string;
  language: string;
  title: string;
  author?: string;
  manifest: ManifestItem[];
  spine: SpineItem[];
  /** the OPF as text */
  source: string;
}

export const CONTAINER_PATH = "META-INF/container.xml";

function attr(event: ScanEvent, name: string): string | undefined {
  return event.attrs?.find((a) => a.name === name)?.value;
}

/** The text of the element the event at `index` opens, if it holds text at all. */
function textOf(events: ScanEvent[], index: number): string {
  const next = events[index + 1];
  return next && next.kind === "text" ? (next.text ?? "") : "";
}

function entryText(entries: ZipEntry[], path: string): string {
  const entry = entries.find((e) => e.path === path);
  if (!entry) throw new EpubReadError(`${path} is not in the archive`, "MISSING_ENTRY");
  return entry.bytes.toString("utf8");
}

export function findPackagePath(entries: ZipEntry[]): string {
  const source = entryText(entries, CONTAINER_PATH);
  for (const event of scan(source, CONTAINER_PATH)) {
    if (event.kind !== "opentag" || event.name !== "rootfile") continue;
    const full = attr(event, "full-path");
    if (full) return full;
  }
  throw new EpubReadError("the container names no root file", "NO_ROOT_FILE");
}

export function readPackage(entries: ZipEntry[]): PackageDoc {
  const path = findPackagePath(entries);
  const source = entryText(entries, path);
  const events = scan(source, path);

  let uniqueIdentifierId = "";
  let uniqueIdentifier = "";
  let language = "";
  let title = "";
  let author: string | undefined;
  const identifiers = new Map<string, string>();
  const manifest: ManifestItem[] = [];
  const spine: SpineItem[] = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.kind !== "opentag") continue;

    switch (event.name) {
      case "package":
        uniqueIdentifierId = attr(event, "unique-identifier") ?? "";
        break;
      case "dc:identifier": {
        const id = attr(event, "id") ?? "";
        identifiers.set(id, textOf(events, i));
        break;
      }
      case "dc:language":
        if (language === "") language = textOf(events, i);
        break;
      case "dc:title":
        if (title === "") title = textOf(events, i);
        break;
      case "dc:creator":
        if (author === undefined) author = textOf(events, i);
        break;
      case "item": {
        const id = attr(event, "id");
        const href = attr(event, "href");
        if (id === undefined || href === undefined) break;
        const properties = attr(event, "properties");
        const mediaOverlay = attr(event, "media-overlay");
        manifest.push({
          id,
          href: decodeEntities(href),
          mediaType: attr(event, "media-type") ?? "",
          ...(properties === undefined ? {} : { properties }),
          ...(mediaOverlay === undefined ? {} : { mediaOverlay }),
        });
        break;
      }
      case "itemref": {
        const idref = attr(event, "idref");
        if (idref === undefined) break;
        const properties = attr(event, "properties");
        spine.push({
          idref,
          linear: attr(event, "linear") !== "no",
          ...(properties === undefined ? {} : { properties }),
        });
        break;
      }
      default:
        break;
    }
  }

  uniqueIdentifier = identifiers.get(uniqueIdentifierId) ?? [...identifiers.values()][0] ?? "";

  return { path, uniqueIdentifier, language, title, author, manifest, spine, source };
}

function isoSeconds(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/**
 * The only two fields of the package we may touch.
 *
 * `dc:identifier` in particular is immutable: it is the key the font
 * obfuscation is derived from, and changing it corrupts the fonts in silence —
 * EPUBCheck does not catch it, because RSC-004 skips the content of encrypted
 * resources. Titles, descriptions and subjects are metadata and stay as they
 * are.
 */
export function writeLanguage(opf: string, language: string, modified: Date): string {
  let out = opf.replace(
    /<dc:language(\s[^>]*)?>[\s\S]*?<\/dc:language>/g,
    (_whole, attrs: string | undefined) => `<dc:language${attrs ?? ""}>${escapeText(language)}</dc:language>`,
  );

  const stamp = isoSeconds(modified);
  const meta = /<meta\s[^>]*property\s*=\s*["']dcterms:modified["'][^>]*>[\s\S]*?<\/meta>/;
  if (meta.test(out)) {
    out = out.replace(meta, `<meta property="dcterms:modified">${stamp}</meta>`);
  } else {
    out = out.replace(
      /<\/metadata>/,
      `  <meta property="dcterms:modified">${stamp}</meta>\n  </metadata>`,
    );
  }
  return out;
}

function primarySubtag(tag: string): string {
  return tag.split("-")[0].toLowerCase();
}

/**
 * Languages are compared by primary subtag, never as exact strings. A package
 * that declares `en-us` over a document that carries `en` is a real case, found
 * on real books: with an exact comparison the document is left alone and the
 * language invariant fails at the end of the run.
 */
export function writeRootLang(xhtml: string, language: string): string {
  const open = /<html\b[^>]*>/i.exec(xhtml);
  if (!open) return xhtml;

  let tag = open[0];
  let touched = false;
  for (const name of ["xml:lang", "lang"]) {
    const pattern = new RegExp(`(\\s${name}\\s*=\\s*)(["'])(.*?)\\2`);
    const found = pattern.exec(tag);
    if (!found) continue;
    touched = true;
    if (primarySubtag(found[3]) === primarySubtag(language)) continue;
    tag = tag.replace(pattern, `$1$2${language}$2`);
  }

  if (!touched) {
    const selfClosing = tag.endsWith("/>");
    const head = tag.slice(0, selfClosing ? -2 : -1).trimEnd();
    tag = `${head} xml:lang="${language}" lang="${language}"${selfClosing ? "/>" : ">"}`;
  }

  return xhtml.slice(0, open.index) + tag + xhtml.slice(open.index + open[0].length);
}
