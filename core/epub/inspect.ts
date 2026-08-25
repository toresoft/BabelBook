import { createHash } from "node:crypto";
import type { ZipEntry } from "./zip.ts";

/**
 * The book, described.
 *
 * This module walks XML with a reader written here, and shares nothing with the
 * one the pipeline transforms with. If the code that verifies and the code that
 * transforms held the same assumptions, a defect of the reader would be
 * symmetric — and therefore invisible to a before/after comparison. The
 * duplication is the point, and a test enforces it.
 */

export interface NavEntry {
  label: string;
  href: string;
  depth: number;
}

export interface GuideRef {
  type: string;
  title: string;
  href: string;
}

export interface EpubModel {
  opfPath: string;
  resourcePaths: string[];
  /** path → sha256, for the resources the pipeline never rewrites */
  binaryHashes: Record<string, string>;
  /** canonical form, comparable as text */
  manifest: string;
  /** canonical form, comparable as text */
  spine: string;
  elementIds: Record<string, string[]>;
  /** the text of every content document, so the invariants can reread it */
  documents: Record<string, string>;
  internalLinks: Array<{ from: string; href: string }>;
  nav: NavEntry[];
  guide: GuideRef[];
  spineToc: string | null;
  languages: Record<string, string>;
  uniqueIdentifier: string;
  /** identifiers, title and creator, canonical: metadata we may never rewrite */
  identityMetadata: string;
  /** the opf:* attributes, in the order they appear */
  opfAttributes: string;
  overlays: { smil: string[]; mediaAttributes: number; mediaMetadata: number };
  mimetypeConformant: boolean;
}

interface Attribute {
  name: string;
  value: string;
}

type Token =
  | { kind: "open"; name: string; attrs: Attribute[]; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

/** Enough of an entity decoder to compare labels; the rest is left as written. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const known: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return known[body] ?? whole;
  });
}

function parseAttributes(body: string): Attribute[] {
  const attrs: Attribute[] = [];
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    attrs.push({ name: match[1], value: decode(match[2] ?? match[3] ?? match[4] ?? "") });
  }
  return attrs;
}

/**
 * A walker that only has to cross tags and text: open, close, empty element,
 * comment, CDATA and processing instruction. No validation, no namespaces —
 * independence is what is wanted here, not completeness.
 */
function walk(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;

  while (at < source.length) {
    const lt = source.indexOf("<", at);
    if (lt === -1) {
      tokens.push({ kind: "text", text: decode(source.slice(at)) });
      break;
    }
    if (lt > at) tokens.push({ kind: "text", text: decode(source.slice(at, lt)) });

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt);
      at = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt);
      const stop = end === -1 ? source.length : end;
      tokens.push({ kind: "text", text: source.slice(lt + 9, stop) });
      at = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt);
      at = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source.startsWith("<!", lt)) {
      const end = source.indexOf(">", lt);
      at = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("</", lt)) {
      const end = source.indexOf(">", lt);
      const stop = end === -1 ? source.length : end;
      tokens.push({ kind: "close", name: source.slice(lt + 2, stop).trim().toLowerCase() });
      at = end === -1 ? source.length : end + 1;
      continue;
    }

    // An open tag: find its `>`, skipping any that sits inside a quoted value.
    let cursor = lt + 1;
    let quote = "";
    while (cursor < source.length) {
      const ch = source[cursor];
      if (quote !== "") {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      cursor += 1;
    }
    const raw = source.slice(lt + 1, cursor);
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameEnd = body.search(/[\s/]/);
    const name = (nameEnd === -1 ? body : body.slice(0, nameEnd)).toLowerCase();
    tokens.push({
      kind: "open",
      name,
      attrs: parseAttributes(nameEnd === -1 ? "" : body.slice(nameEnd)),
      selfClosing,
    });
    at = cursor + 1;
  }

  return tokens;
}

function get(attrs: Attribute[], name: string): string | undefined {
  return attrs.find((a) => a.name.toLowerCase() === name)?.value;
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at + 1);
}

const DOCUMENTS = [".xhtml", ".html", ".htm"];

function isDocument(path: string): boolean {
  const lower = path.toLowerCase();
  return DOCUMENTS.some((ext) => lower.endsWith(ext));
}

function text(entries: ZipEntry[], path: string): string {
  const entry = entries.find((e) => e.path === path);
  return entry ? entry.bytes.toString("utf8") : "";
}

function findOpfPath(entries: ZipEntry[]): string {
  for (const token of walk(text(entries, "META-INF/container.xml"))) {
    if (token.kind !== "open" || token.name !== "rootfile") continue;
    const full = get(token.attrs, "full-path");
    if (full) return full;
  }
  return entries.find((e) => e.path.toLowerCase().endsWith(".opf"))?.path ?? "";
}

interface OpfFacts {
  manifest: string;
  spine: string;
  spineToc: string | null;
  uniqueIdentifier: string;
  opfAttributes: string;
  guide: GuideRef[];
  hrefById: Map<string, string>;
  navHref: string;
  identityMetadata: string;
  mediaAttributes: number;
  mediaMetadata: number;
}

const IDENTITY_ELEMENTS = ["dc:identifier", "dc:title", "dc:creator"];

function readOpf(source: string): OpfFacts {
  const manifest: string[] = [];
  const spine: string[] = [];
  const guide: GuideRef[] = [];
  const hrefById = new Map<string, string>();
  const identifiers = new Map<string, string>();
  const opfAttributes: string[] = [];

  let uniqueId = "";
  let navHref = "";
  let spineToc: string | null = null;
  let mediaAttributes = 0;
  let mediaMetadata = 0;
  let pendingIdentifier: string | null = null;
  let spineIndex = 0;
  let collecting: string | null = null;
  let collected = "";
  const identity: string[] = [];

  const tokens = walk(source);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === "text") {
      if (pendingIdentifier !== null) {
        identifiers.set(pendingIdentifier, (identifiers.get(pendingIdentifier) ?? "") + token.text);
      }
      if (collecting !== null) collected += token.text;
      continue;
    }
    if (token.kind === "close") {
      if (token.name === "dc:identifier") pendingIdentifier = null;
      if (collecting !== null && token.name === collecting) {
        identity.push(`${collecting}|${collected.trim()}`);
        collecting = null;
        collected = "";
      }
      continue;
    }
    if (IDENTITY_ELEMENTS.includes(token.name) && !token.selfClosing) {
      collecting = token.name;
      collected = "";
    }

    for (const attr of token.attrs) {
      if (attr.name.toLowerCase().startsWith("opf:")) {
        opfAttributes.push(`${token.name}@${attr.name}=${attr.value}`);
      }
      if (attr.name.toLowerCase() === "media-overlay") mediaAttributes += 1;
    }

    switch (token.name) {
      case "package":
        uniqueId = get(token.attrs, "unique-identifier") ?? "";
        break;
      case "dc:identifier":
        pendingIdentifier = get(token.attrs, "id") ?? "";
        identifiers.set(pendingIdentifier, "");
        break;
      case "meta": {
        const property = get(token.attrs, "property") ?? "";
        if (property.startsWith("media:")) mediaMetadata += 1;
        break;
      }
      case "item": {
        const id = get(token.attrs, "id") ?? "";
        const href = get(token.attrs, "href") ?? "";
        const properties = get(token.attrs, "properties") ?? "";
        hrefById.set(id, href);
        if (properties.split(/\s+/).includes("nav")) navHref = href;
        manifest.push([id, href, get(token.attrs, "media-type") ?? "", properties].join("|"));
        break;
      }
      case "spine":
        spineToc = get(token.attrs, "toc") ?? null;
        break;
      case "itemref":
        spine.push(
          [
            spineIndex++,
            get(token.attrs, "idref") ?? "",
            get(token.attrs, "linear") === "no" ? "no" : "yes",
            get(token.attrs, "properties") ?? "",
          ].join("|"),
        );
        break;
      case "reference":
        guide.push({
          type: get(token.attrs, "type") ?? "",
          title: get(token.attrs, "title") ?? "",
          href: get(token.attrs, "href") ?? "",
        });
        break;
      default:
        break;
    }
  }

  return {
    manifest: manifest.slice().sort().join("\n"),
    spine: spine.join("\n"),
    spineToc,
    uniqueIdentifier: identifiers.get(uniqueId) ?? [...identifiers.values()][0] ?? "",
    opfAttributes: opfAttributes.join("\n"),
    guide,
    hrefById,
    navHref,
    identityMetadata: identity.slice().sort().join("\n"),
    mediaAttributes,
    mediaMetadata,
  };
}

function readNav(source: string): NavEntry[] {
  const entries: NavEntry[] = [];
  const tokens = walk(source);

  let inToc = 0;
  let depth = 0;
  let label: string | null = null;
  let href = "";

  for (const token of tokens) {
    if (token.kind === "text") {
      if (label !== null) label += token.text;
      continue;
    }
    if (token.kind === "open") {
      if (token.name === "nav") {
        const type = get(token.attrs, "epub:type") ?? get(token.attrs, "type") ?? "";
        if (type.split(/\s+/).includes("toc") || inToc > 0) inToc += 1;
        else inToc = 0;
        continue;
      }
      if (inToc === 0) continue;
      if (token.name === "ol" || token.name === "ul") depth += 1;
      if ((token.name === "a" || token.name === "span") && !token.selfClosing) {
        label = "";
        href = get(token.attrs, "href") ?? "";
      }
      continue;
    }
    if (token.name === "nav" && inToc > 0) inToc -= 1;
    if (inToc === 0) continue;
    if (token.name === "ol" || token.name === "ul") depth -= 1;
    if ((token.name === "a" || token.name === "span") && label !== null) {
      entries.push({ label: label.trim(), href, depth });
      label = null;
      href = "";
    }
  }

  return entries;
}

const LINK_ATTRIBUTES = ["href", "src", "xlink:href"];

function isExternal(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("//");
}

export function inspect(entries: ZipEntry[]): EpubModel {
  const opfPath = findOpfPath(entries);
  const opf = readOpf(text(entries, opfPath));

  const elementIds: Record<string, string[]> = {};
  const documents: Record<string, string> = {};
  const internalLinks: Array<{ from: string; href: string }> = [];
  const languages: Record<string, string> = {};
  const binaryHashes: Record<string, string> = {};

  for (const entry of entries) {
    // Content documents and the package are what the pipeline rewrites; every
    // other resource must come out of the run byte for byte.
    const rewritten = isDocument(entry.path)
      || entry.path === opfPath
      || entry.path.toLowerCase().endsWith(".ncx");
    if (!rewritten) {
      binaryHashes[entry.path] = createHash("sha256").update(entry.bytes).digest("hex");
    }
    if (!isDocument(entry.path)) continue;

    const source = entry.bytes.toString("utf8");
    documents[entry.path] = source;

    const ids: string[] = [];
    let root = true;
    for (const token of walk(source)) {
      if (token.kind !== "open") continue;
      if (root && token.name === "html") {
        const lang = get(token.attrs, "xml:lang") ?? get(token.attrs, "lang");
        if (lang !== undefined) languages[entry.path] = lang;
        root = false;
      }
      const id = get(token.attrs, "id");
      if (id !== undefined) ids.push(id);
      for (const name of LINK_ATTRIBUTES) {
        const href = get(token.attrs, name);
        if (href === undefined || href === "" || isExternal(href)) continue;
        internalLinks.push({ from: entry.path, href });
      }
    }
    elementIds[entry.path] = ids;
  }

  const navPath = opf.navHref === "" ? "" : `${directoryOf(opfPath)}${opf.navHref}`;
  const nav = navPath === "" ? [] : readNav(text(entries, navPath));

  const first = entries[0];
  const mimetypeConformant =
    first !== undefined
    && first.path === "mimetype"
    && first.bytes.toString("utf8") === "application/epub+zip";

  return {
    opfPath,
    resourcePaths: entries.map((e) => e.path).sort(),
    binaryHashes,
    manifest: opf.manifest,
    spine: opf.spine,
    elementIds,
    documents,
    internalLinks,
    nav,
    guide: opf.guide,
    spineToc: opf.spineToc,
    languages,
    uniqueIdentifier: opf.uniqueIdentifier,
    identityMetadata: opf.identityMetadata,
    opfAttributes: opf.opfAttributes,
    overlays: {
      smil: entries.filter((e) => e.path.toLowerCase().endsWith(".smil")).map((e) => e.path).sort(),
      mediaAttributes: opf.mediaAttributes,
      mediaMetadata: opf.mediaMetadata,
    },
    mimetypeConformant,
  };
}
