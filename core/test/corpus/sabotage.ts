/**
 * Negative controls.
 *
 * A suite that has never failed has not shown it can. Every invariant that can
 * have one gets a defect built on purpose to make it fire. If a sabotage comes
 * through unharmed, the invariant is broken, not the sabotage.
 */
import type { TranslationUnit } from "../../epub/blocks.ts";
import { render } from "../../epub/splice.ts";
import { readEpub, writeEpub, type ZipEntry } from "../../epub/zip.ts";

export interface Sabotage {
  name: string;
  description: string;
  /** At least one of these invariants MUST fail. */
  trips: string[];
  apply(entries: ZipEntry[], units: TranslationUnit[]): Promise<ZipEntry[]>;
}

const DOCUMENT = "OEBPS/c1.xhtml";
const NAV = "OEBPS/nav.xhtml";
const OPF = "OEBPS/content.opf";

function edit(entries: ZipEntry[], path: string, change: (text: string) => string): ZipEntry[] {
  return entries.map((entry) =>
    entry.path === path
      ? { ...entry, bytes: Buffer.from(change(entry.bytes.toString("utf8")), "utf8") }
      : entry,
  );
}

function editAll(entries: ZipEntry[], change: (text: string, path: string) => string): ZipEntry[] {
  return entries.map((entry) => ({
    ...entry,
    bytes: Buffer.from(change(entry.bytes.toString("utf8"), entry.path), "utf8"),
  }));
}

function replaceRange(text: string, range: [number, number], value: string): string {
  return text.slice(0, range[0]) + value + text.slice(range[1]);
}

function blockUnit(units: TranslationUnit[]): TranslationUnit {
  const unit = units.find((u) => u.kind === "block");
  if (!unit) throw new Error("the fixture produced no block unit");
  return unit;
}

/** An HTML-flavoured serializer: it drops the declaration and closes nothing. */
function reserialize(text: string): string {
  return text
    .replace(/<\?xml[^?]*\?>\s*/g, "")
    .replace(/\s*\/>/g, ">")
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)));
}

export const SABOTAGES: Sabotage[] = [
  {
    name: "naive-regex",
    description: "translates with a textual substitution that eats the tags",
    trips: ["I17", "I5"],
    async apply(entries) {
      // What a substitution over the whole body really does: the text comes
      // back translated and the markup around it does not come back at all.
      return edit(entries, DOCUMENT, (text) =>
        text.replace(
          /<body>[\s\S]*<\/body>/,
          "<body>Una affermazione audace con ls e un gatto</body>",
        ));
    },
  },
  {
    name: "renumber-ids",
    description: "renumbers the element ids",
    // I6 would go with it on a book whose links carry fragments; this fixture
    // has none, and claiming an invariant the corpus cannot reach would make
    // the mapping a wish rather than a control.
    trips: ["I5"],
    async apply(entries) {
      return editAll(entries, (text, path) =>
        path.endsWith(".xhtml") ? text.replace(/\bid="p1"/g, 'id="q9"') : text);
    },
  },
  {
    name: "new-identifier",
    description: "coins a new dc:identifier for the translated edition",
    trips: ["I8", "I9"],
    async apply(entries) {
      return edit(entries, OPF, (text) =>
        text.replace(
          /<dc:identifier([^>]*)>[^<]*<\/dc:identifier>/,
          '<dc:identifier$1>urn:uuid:00000000-0000-0000-0000-000000000000</dc:identifier>',
        ));
    },
  },
  {
    name: "drop-placeholder",
    description: "leaves one placeholder out of the rendering",
    trips: ["I17"],
    async apply(entries, units) {
      const unit = blockUnit(units);
      const rendered = render(unit, "A claim with <1></1> and <2/>");
      return edit(entries, DOCUMENT, (text) => replaceRange(text, unit.range, rendered));
    },
  },
  {
    name: "drop-attributed-tag",
    description: "removes a tag that carried a translated attribute",
    // The tag carrying the attribute is an `img`, and an `img` has no id: the
    // loss is one of markup, which is I17's business, not I5's.
    trips: ["I17"],
    async apply(entries, units) {
      const unit = blockUnit(units);
      const rendered = render(unit, "A <0>bold</0> claim with <1></1> and nothing");
      return edit(entries, DOCUMENT, (text) => replaceRange(text, unit.range, rendered));
    },
  },
  {
    name: "translate-opaque",
    description: "translates the content of an opaque element",
    trips: ["I18"],
    async apply(entries) {
      return edit(entries, DOCUMENT, (text) => text.replace("<code>ls</code>", "<code>elenca</code>"));
    },
  },
  {
    name: "empty-nav-label",
    description: "empties a navigation label",
    trips: ["I7"],
    async apply(entries) {
      return edit(entries, NAV, (text) => text.replace(/>Chapter 1</, "><"));
    },
  },
  {
    name: "rezip-naive",
    description: "rewrites the zip with mimetype no longer first",
    trips: ["I13"],
    async apply(entries) {
      const mimetype = entries.find((e) => e.path === "mimetype")!;
      const shuffled = [...entries.filter((e) => e.path !== "mimetype"), mimetype];
      const written = await writeEpub(shuffled, { conformant: false });
      return (await readEpub(written)).entries;
    },
  },
  {
    name: "swap-block-range",
    description: "swaps the ranges of two units",
    // The one sabotage that damages the units instead of the archive: the
    // invariant it exists for is precisely the one asserting that a unit still
    // describes its document, and no state of the archive can express that.
    trips: ["I20"],
    async apply(entries, units) {
      const [first, second] = units;
      if (!second) throw new Error("the fixture produced only one unit");
      const range = first.range;
      first.range = second.range;
      second.range = range;
      return entries;
    },
  },
  {
    name: "reserialize",
    description: "reserializes every document with a parser that normalizes tags and attributes",
    trips: ["I2", "I12"],
    async apply(entries) {
      return editAll(entries, (text, path) =>
        path.endsWith(".xhtml") || path.endsWith(".xml") || path.endsWith(".opf")
          ? reserialize(text)
          : text);
    },
  },
  {
    name: "orphan-placeholder",
    description: "leaves a numeric marker in the output",
    trips: ["I17"],
    async apply(entries, units) {
      const unit = blockUnit(units);
      return edit(entries, DOCUMENT, (text) => replaceRange(text, unit.range, unit.source));
    },
  },
  {
    name: "half-removed-overlay",
    description: "takes the smil files away but leaves media-overlay and media:duration",
    trips: ["I22"],
    async apply(entries) {
      return edit(entries, OPF, (text) =>
        text
          .replace(/(<item id="d0"[^>]*?)\/>/, '$1 media-overlay="smil0"/>')
          .replace(
            /<\/metadata>/,
            '  <meta property="media:duration">0:00:05</meta>\n  </metadata>',
          ));
    },
  },
];
