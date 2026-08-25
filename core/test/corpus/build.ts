/**
 * A generator of EPUB fixtures.
 *
 * It writes the archive with `yazl` directly, never through `core/epub/zip.ts`.
 * That is deliberate: fixtures produced by the very writer the tests exercise
 * would hide a defect of that writer behind its own symmetry.
 */
import { ZipFile } from "yazl";

export type FixtureLayout = "reflowable" | "pre-paginated";

export interface EpubDocumentSpec {
  path: string;
  xhtml: string;
  layout?: FixtureLayout;
}

export interface EpubExtraSpec {
  path: string;
  bytes: Buffer;
}

export interface EpubOverlaySpec {
  smilPath: string;
  audioPath: string;
  forDocument: string;
  duration: string;
}

export interface EpubSpec {
  identifier?: string;
  language?: string;
  title?: string;
  documents: EpubDocumentSpec[];
  extra?: EpubExtraSpec[];
  packageProperties?: string;
  manifestExtra?: string;
  metadataExtra?: string;
  overlays?: EpubOverlaySpec[];
}

const DEFAULT_IDENTIFIER = "urn:uuid:11111111-2222-3333-4444-555555555555";
const DEFAULT_LANGUAGE = "en";
const DEFAULT_TITLE = "Fixture";

/** Fixed, so two builds of the same spec produce the same bytes. */
const MTIME = new Date("2026-01-01T00:00:00Z");

export const OPF_PATH = "OEBPS/content.opf";
export const OPF_DIR = "OEBPS/";
export const NAV_PATH = "OEBPS/nav.xhtml";

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attrEscape(text: string): string {
  return xmlEscape(text).replace(/"/g, "&quot;");
}

/** An archive path expressed relative to the package document. */
function href(path: string): string {
  return path.startsWith(OPF_DIR) ? path.slice(OPF_DIR.length) : path;
}

function wrapDocument(spec: EpubDocumentSpec, language: string, title: string): string {
  const viewport =
    spec.layout === "pre-paginated"
      ? `<meta name="viewport" content="width=1200, height=1600"/>`
      : "";
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"`
    + ` xml:lang="${attrEscape(language)}" lang="${attrEscape(language)}">\n`
    + `<head><title>${xmlEscape(title)}</title>${viewport}</head>\n`
    + `<body>${spec.xhtml}</body>\n`
    + `</html>\n`
  );
}

function containerXml(): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n`
    + `  <rootfiles>\n`
    + `    <rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/>\n`
    + `  </rootfiles>\n`
    + `</container>\n`
  );
}

function navXhtml(spec: EpubSpec, language: string, title: string): string {
  const items = spec.documents
    .map((d, i) => `<li><a href="${attrEscape(href(d.path))}">Chapter ${i + 1}</a></li>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"`
    + ` xml:lang="${attrEscape(language)}" lang="${attrEscape(language)}">\n`
    + `<head><title>${xmlEscape(title)}</title></head>\n`
    + `<body><nav epub:type="toc"><ol>${items}</ol></nav></body>\n`
    + `</html>\n`
  );
}

export function documentId(index: number): string {
  return `d${index}`;
}

function smilId(index: number): string {
  return `smil${index}`;
}

function smilXml(overlay: EpubOverlaySpec): string {
  const text = `${href(overlay.forDocument)}#p1`;
  const audio = href(overlay.audioPath);
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0">\n`
    + `  <body><seq><par>`
    + `<text src="${attrEscape(text)}"/>`
    + `<audio src="${attrEscape(audio)}" clipBegin="0:00:00" clipEnd="${attrEscape(overlay.duration)}"/>`
    + `</par></seq></body>\n`
    + `</smil>\n`
  );
}

function packageOpf(spec: EpubSpec, language: string, title: string): string {
  const identifier = spec.identifier ?? DEFAULT_IDENTIFIER;

  const overlays = spec.overlays ?? [];
  const overlayOf = (path: string): number =>
    overlays.findIndex((o) => o.forDocument === path);

  const manifest = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    ...spec.documents.map((d, i) => {
      const overlay = overlayOf(d.path);
      const attached = overlay === -1 ? "" : ` media-overlay="${smilId(overlay)}"`;
      return (
        `    <item id="${documentId(i)}" href="${attrEscape(href(d.path))}"`
        + ` media-type="application/xhtml+xml"${attached}/>`
      );
    }),
    ...overlays.map(
      (o, i) =>
        `    <item id="${smilId(i)}" href="${attrEscape(href(o.smilPath))}"`
        + ` media-type="application/smil+xml"/>`,
    ),
    ...overlays.map(
      (o, i) =>
        `    <item id="audio${i}" href="${attrEscape(href(o.audioPath))}" media-type="audio/mpeg"/>`,
    ),
  ];
  if (spec.manifestExtra) manifest.push(`    ${spec.manifestExtra}`);

  const spine = spec.documents.map((d, i) => {
    const properties =
      d.layout === "pre-paginated"
        ? ` properties="rendition:layout-pre-paginated"`
        : d.layout === "reflowable"
          ? ` properties="rendition:layout-reflowable"`
          : "";
    return `    <itemref idref="${documentId(i)}"${properties}/>`;
  });

  const metadata = [
    `    <dc:identifier id="pub-id">${xmlEscape(identifier)}</dc:identifier>`,
    `    <dc:title>${xmlEscape(title)}</dc:title>`,
    `    <dc:language>${xmlEscape(language)}</dc:language>`,
    `    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>`,
  ];
  if (spec.packageProperties) metadata.push(`    ${spec.packageProperties}`);
  for (const [i, overlay] of overlays.entries()) {
    metadata.push(
      `    <meta property="media:duration" refines="#${smilId(i)}">${xmlEscape(overlay.duration)}</meta>`,
    );
  }
  if (overlays.length > 0) {
    metadata.push(`    <meta property="media:duration">${xmlEscape(overlays[0].duration)}</meta>`);
    metadata.push(`    <meta property="media:narrator">Voice</meta>`);
  }
  if (spec.metadataExtra) metadata.push(`    ${spec.metadataExtra}`);

  return (
    `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"`
    + ` unique-identifier="pub-id" xml:lang="${attrEscape(language)}">\n`
    + `  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n`
    + `${metadata.join("\n")}\n`
    + `  </metadata>\n`
    + `  <manifest>\n`
    + `${manifest.join("\n")}\n`
    + `  </manifest>\n`
    + `  <spine>\n`
    + `${spine.join("\n")}\n`
    + `  </spine>\n`
    + `</package>\n`
  );
}

/**
 * A name `yazl` refuses, rewritten to one it accepts and of the same byte
 * length, so the finished archive can be patched back to the original name.
 * Returns null when the name needs no alias.
 */
function unsafeAlias(path: string): string | null {
  const segments = path.split("/");
  if (!path.startsWith("/") && !segments.includes("..")) return null;
  const aliased = segments.map((s) => (s === ".." ? "\u0001\u0001" : s)).join("/");
  return path.startsWith("/") ? `\u0001${aliased.slice(1)}` : aliased;
}

function patchName(archive: Buffer, alias: string, real: string): Buffer {
  const from = Buffer.from(alias, "utf8");
  const to = Buffer.from(real, "utf8");
  if (from.length !== to.length) {
    throw new Error(`alias ${JSON.stringify(alias)} is not the length of ${JSON.stringify(real)}`);
  }
  let hits = 0;
  let at = archive.indexOf(from);
  while (at !== -1) {
    to.copy(archive, at);
    hits += 1;
    at = archive.indexOf(from, at + from.length);
  }
  // A name lives in exactly two places: the local file header and the central
  // directory. Any other count means the patch hit something it should not.
  if (hits !== 2) throw new Error(`patched ${hits} occurrences of ${JSON.stringify(alias)}, expected 2`);
  return archive;
}

export async function buildEpub(spec: EpubSpec): Promise<Buffer> {
  const language = spec.language ?? DEFAULT_LANGUAGE;
  const title = spec.title ?? DEFAULT_TITLE;

  const files: Array<{ path: string; bytes: Buffer; compress: boolean }> = [
    { path: "mimetype", bytes: Buffer.from("application/epub+zip", "utf8"), compress: false },
    { path: "META-INF/container.xml", bytes: Buffer.from(containerXml(), "utf8"), compress: true },
    { path: OPF_PATH, bytes: Buffer.from(packageOpf(spec, language, title), "utf8"), compress: true },
    { path: NAV_PATH, bytes: Buffer.from(navXhtml(spec, language, title), "utf8"), compress: true },
  ];

  for (const document of spec.documents) {
    files.push({
      path: document.path,
      bytes: Buffer.from(wrapDocument(document, language, title), "utf8"),
      compress: true,
    });
  }
  for (const overlay of spec.overlays ?? []) {
    files.push({ path: overlay.smilPath, bytes: Buffer.from(smilXml(overlay), "utf8"), compress: true });
    files.push({ path: overlay.audioPath, bytes: Buffer.from("fake audio", "utf8"), compress: true });
  }
  for (const extra of spec.extra ?? []) {
    files.push({ path: extra.path, bytes: extra.bytes, compress: true });
  }

  const zip = new ZipFile();
  const aliases: Array<{ alias: string; real: string }> = [];
  for (const file of files) {
    const alias = unsafeAlias(file.path);
    if (alias !== null) aliases.push({ alias, real: file.path });
    zip.addBuffer(file.bytes, alias ?? file.path, { compress: file.compress, mtime: MTIME });
  }
  zip.end();

  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  let archive = Buffer.concat(chunks);
  for (const { alias, real } of aliases) archive = patchName(archive, alias, real);
  return archive;
}
