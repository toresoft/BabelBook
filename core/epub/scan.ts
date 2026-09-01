import { SaxesParser } from "saxes";
import { XHTML_ENTITIES } from "./entities.ts";
import { ScanError } from "../errors.ts";

export type ScanKind = "opentag" | "closetag" | "text" | "cdata" | "comment" | "pi" | "doctype";

/** Offsets of the attribute's *value*, quotes excluded, relative to its opening tag. */
export interface ScanAttr {
  name: string;
  value: string;
  start: number;
  end: number;
}

export interface ScanEvent {
  kind: ScanKind;
  name?: string;
  attrs?: ScanAttr[];
  text?: string;
  rawStart: number;
  rawEnd: number;
  /** False when the raw range does not decode back to what the parser reported. */
  reliable: boolean;
  selfClosing?: boolean;
}

const NUMERIC = /^#(x)?([0-9a-fA-F]+)$/;

/**
 * A fresh regular expression per call. A shared one with the `g` flag keeps its
 * `lastIndex` between calls and poisons the next string it is handed.
 */
function entityPattern(): RegExp {
  return /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;
}

export function decodeEntities(raw: string): string {
  return raw.replace(entityPattern(), (whole, body: string) => {
    const numeric = NUMERIC.exec(body);
    if (numeric) {
      const code = Number.parseInt(numeric[2], numeric[1] ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = XHTML_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

export function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** XML collapses these before reporting a value; the raw range still holds them. */
function normalizeSpace(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeAttrSpace(s: string): string {
  return normalizeSpace(s).replace(/[\n\t]/g, " ");
}

/** Matches `name="value"` or `name='value'`, with the value's own offsets. */
function attributePattern(): RegExp {
  return /([:A-Za-z_][-.:A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/dg;
}

interface AttrIndices {
  indices?: Array<[number, number] | undefined>;
}

function reportedValue(reported: unknown): string | undefined {
  if (typeof reported === "string") return reported;
  if (reported && typeof reported === "object" && "value" in reported) {
    const value = (reported as { value: unknown }).value;
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Attribute offsets come from re-reading the raw tag, and each one is confirmed
 * against the value the parser reported. Without the confirmation an attribute
 * that repeats another's text hands back the wrong offset, and a translation
 * lands in the wrong place.
 */
function attributesOf(
  rawTag: string,
  attributes: Record<string, unknown>,
): { attrs: ScanAttr[]; reliable: boolean } {
  const attrs: ScanAttr[] = [];
  let reliable = true;
  const seen = new Set<string>();
  const pattern = attributePattern();

  let match: (RegExpExecArray & AttrIndices) | null;
  while ((match = pattern.exec(rawTag) as (RegExpExecArray & AttrIndices) | null) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    const reported = reportedValue(attributes[name]);
    if (reported === undefined) continue;

    const span = match.indices?.[2] ?? match.indices?.[3];
    if (!span) continue;

    const rawValue = rawTag.slice(span[0], span[1]);
    if (normalizeAttrSpace(decodeEntities(rawValue)) !== normalizeAttrSpace(reported)) {
      reliable = false;
      continue;
    }
    seen.add(name);
    attrs.push({ name, value: reported, start: span[0], end: span[1] });
  }

  // Every attribute the parser saw must have been located, or an offset is missing.
  if (seen.size !== Object.keys(attributes).length) reliable = false;
  return { attrs, reliable };
}

interface ScanOutcome {
  events: ScanEvent[];
  errors: Error[];
}

function scanInternal(source: string, path: string): ScanOutcome {
  const parser = new SaxesParser({ xmlns: true, position: true, fileName: path });
  // The parser and `decodeEntities` must agree, so both read the same table.
  Object.assign(parser.ENTITIES, XHTML_ENTITIES);

  const events: ScanEvent[] = [];
  const errors: Error[] = [];
  /** End of the last event emitted: where the next one begins. */
  let cursor = 0;

  const emit = (event: ScanEvent): void => {
    events.push(event);
    cursor = event.rawEnd;
  };

  parser.on("error", (error) => errors.push(error));

  parser.on("xmldecl", () => {
    emit({ kind: "pi", name: "xml", rawStart: cursor, rawEnd: parser.position, reliable: true });
  });

  parser.on("processinginstruction", (pi) => {
    emit({ kind: "pi", name: pi.target, rawStart: cursor, rawEnd: parser.position, reliable: true });
  });

  parser.on("doctype", () => {
    emit({ kind: "doctype", rawStart: cursor, rawEnd: parser.position, reliable: true });
  });

  parser.on("comment", (text) => {
    // A comment is reported while the parser still sits on the closing `>`,
    // one short of every other structural event.
    let end = parser.position + 1;
    if (source.slice(end - 3, end) !== "-->") {
      const found = source.indexOf("-->", cursor);
      end = found === -1 ? parser.position + 1 : found + 3;
    }
    emit({ kind: "comment", text, rawStart: cursor, rawEnd: end, reliable: true });
  });

  parser.on("cdata", (text) => {
    const rawStart = cursor;
    const rawEnd = parser.position;
    const inner = source.slice(rawStart + "<![CDATA[".length, rawEnd - "]]>".length);
    emit({ kind: "cdata", text, rawStart, rawEnd, reliable: inner === text });
  });

  parser.on("opentag", (tag) => {
    const rawStart = cursor;
    const rawEnd = parser.position;
    const located = attributesOf(source.slice(rawStart, rawEnd), tag.attributes as Record<string, unknown>);
    emit({
      kind: "opentag",
      name: tag.name,
      attrs: located.attrs,
      rawStart,
      rawEnd,
      reliable: located.reliable,
      selfClosing: tag.isSelfClosing,
    });
  });

  parser.on("closetag", (tag) => {
    // A self-closing element reports its close at the very position its open
    // ended: the range is empty, and saying so is more honest than inventing one.
    const rawEnd = parser.position;
    const rawStart = tag.isSelfClosing ? rawEnd : cursor;
    emit({
      kind: "closetag",
      name: tag.name,
      rawStart,
      rawEnd,
      reliable: true,
      selfClosing: tag.isSelfClosing,
    });
  });

  parser.on("text", (text) => {
    // The event fires once the parser has eaten the `<` that ends the node, so
    // the range stops one short of the position — except at the end of the
    // document, where nothing was eaten.
    const atTag = source[parser.position - 1] === "<";
    const rawEnd = Math.max(cursor, atTag ? parser.position - 1 : parser.position);
    const raw = source.slice(cursor, rawEnd);
    const reliable = normalizeSpace(decodeEntities(raw)) === normalizeSpace(text);
    emit({ kind: "text", text, rawStart: cursor, rawEnd, reliable });
  });

  try {
    parser.write(source).close();
  } catch (cause) {
    errors.push(cause instanceof Error ? cause : new Error(String(cause)));
  }

  return { events, errors };
}

export function scan(source: string, path: string): ScanEvent[] {
  return scanInternal(source, path).events;
}

/** Decodes, or fails loudly. The encoding is never guessed: that is the point. */
export function assertUtf8(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ScanError(`${path} is not valid UTF-8`, "UNSUPPORTED_ENCODING");
  }
}

export function assertWellFormed(source: string, path: string): void {
  const { errors } = scanInternal(source, path);
  if (errors.length > 0) {
    throw new ScanError(`${path} is not well-formed XML: ${errors[0].message}`, "MALFORMED_XML");
  }
}
