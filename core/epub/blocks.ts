import { scan, type ScanAttr, type ScanEvent } from "./scan.ts";

export type UnitKind = "block" | "text" | "attribute";

export type UnitState =
  /** to be translated */
  | "translate"
  /** translated, but the code index suspects it is code */
  | "maybe-code"
  /** code: not translated */
  | "code"
  /** script, style: not the book's text */
  | "never-translated"
  /** the author wrote translate="no" */
  | "translate-no"
  /** the range cannot be trusted: leave it alone */
  | "uncomposable";

export interface TranslationUnit {
  /** `${doc}#${ordinal}` */
  id: string;
  kind: UnitKind;
  doc: string;
  ordinal: number;
  /** the unit's range in the source */
  range: [number, number];
  /** decoded text, inline markup masked */
  source: string;
  /** the bytes of the range, not the decoded text */
  raw: string;
  state: UnitState;
  /** a code, never a sentence: "css-code-surface", "unreliable-range" */
  reason?: string;
  placeholders?: Placeholder[];
  /** attribute units only: the block unit that contains them */
  owner?: string;
  /** The element the unit was cut at, when it was cut at one. */
  element?: string;
  /**
   * Its first class, when it has one.
   *
   * From the node, never from `raw`: a block's `raw` is its content, so a
   * class read out of it belongs to the first descendant — and the class is
   * exactly the signal the code index asks a model to weigh.
   */
  className?: string;
}

export interface PlaceholderAttr {
  unitId: string;
  start: number;
  end: number;
}

export interface Placeholder {
  index: number;
  open: string;
  close: string;
  opaque: boolean;
  content?: string;
  rawContent?: string;
  attrs?: PlaceholderAttr[];
}

export interface ExtractReport {
  units: TranslationUnit[];
  skipped: Array<{ doc: string; reason: string; degraded: boolean }>;
}

export const BLOCKS: Set<string> = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "dt", "dd", "blockquote",
  "pre", "figcaption", "caption", "td", "th", "aside", "section", "article",
  "header", "footer", "nav", "details", "summary",
]);

/**
 * In a navigation document a `<li>` admits only `a` or `span`, never bare text.
 * With the list item as the leaf, a translation that leaves one word outside a
 * placeholder produces an EPUB that EPUBCheck refuses, and no level of
 * validation can see it because the placeholder is present and balanced. With
 * the anchor as the leaf the wrong thing stops being expressible.
 */
export const NAV_BLOCKS: Set<string> = new Set([...BLOCKS, "a", "span"]);

export const NEVER_TRANSLATED: Set<string> = new Set(["script", "style"]);

export const OPAQUE: Set<string> = new Set(["code", "kbd", "samp", "var", "tt"]);

const CODE_ELEMENTS = new Set(["pre", "code", "kbd", "samp", "var"]);

export function isWork(state: UnitState): boolean {
  return state === "translate" || state === "maybe-code";
}

interface ElementNode {
  kind: "element";
  name: string;
  attrs: ScanAttr[];
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
  selfClosing: boolean;
  reliable: boolean;
  children: Node[];
}

interface TextNode {
  kind: "text";
  text: string;
  rawStart: number;
  rawEnd: number;
  reliable: boolean;
}

interface OtherNode {
  kind: "other";
  rawStart: number;
  rawEnd: number;
}

type Node = ElementNode | TextNode | OtherNode;

/** Where a node begins in the source, tag included when it has one. */
function startOf(node: Node): number {
  return node.kind === "element" ? node.openStart : node.rawStart;
}

/** Where a node ends in the source, closing tag included when it has one. */
function endOf(node: Node): number {
  return node.kind === "element" ? node.closeEnd : node.rawEnd;
}

function toTree(events: ScanEvent[]): Node[] {
  const roots: Node[] = [];
  const stack: ElementNode[] = [];
  const push = (node: Node): void => {
    const parent = stack[stack.length - 1];
    (parent ? parent.children : roots).push(node);
  };

  for (const event of events) {
    if (event.kind === "opentag") {
      const node: ElementNode = {
        kind: "element",
        name: event.name ?? "",
        attrs: event.attrs ?? [],
        openStart: event.rawStart,
        openEnd: event.rawEnd,
        closeStart: event.rawEnd,
        closeEnd: event.rawEnd,
        selfClosing: event.selfClosing === true,
        reliable: event.reliable,
        children: [],
      };
      push(node);
      if (!node.selfClosing) stack.push(node);
    } else if (event.kind === "closetag") {
      // A self-closing element reports a close of its own; it was never pushed,
      // and popping here would close its parent instead.
      if (event.selfClosing === true) continue;
      const node = stack.pop();
      if (node) {
        node.closeStart = event.rawStart;
        node.closeEnd = event.rawEnd;
      }
    } else if (event.kind === "text") {
      push({
        kind: "text",
        text: event.text ?? "",
        rawStart: event.rawStart,
        rawEnd: event.rawEnd,
        reliable: event.reliable,
      });
    } else {
      push({ kind: "other", rawStart: event.rawStart, rawEnd: event.rawEnd });
    }
  }
  return roots;
}

function attrValue(node: ElementNode, name: string): string | undefined {
  return node.attrs.find((a) => a.name === name)?.value;
}

function classesOf(node: ElementNode): string[] {
  const raw = attrValue(node, "class");
  return raw === undefined ? [] : raw.split(/\s+/).filter((c) => c.length > 0);
}

/**
 * An element that records where a printed page began, rather than something a
 * reader reads.
 *
 * Recognised by what the element declares — `epub:type="pagebreak"` or
 * `role="doc-pagebreak"` — and never by what its label contains. A label that
 * is only digits could be a figure number, a footnote or a year; a declared
 * page break could not be anything else.
 */
function isPageMarker(node: ElementNode): boolean {
  const declared = (attrValue(node, "epub:type") ?? "").split(/\s+/);
  if (declared.includes("pagebreak")) return true;
  return (attrValue(node, "role") ?? "").split(/\s+/).includes("doc-pagebreak");
}

export interface ExtractInput {
  source: string;
  doc: string;
  nav?: boolean;
  /** classes the stylesheet resolved as code surfaces (Task 7) */
  codeSurfaces?: Set<string>;
}

interface Frame {
  translateNo: boolean;
}

/**
 * The line is metadata against content: `alt`, `aria-label`, navigation and
 * NCX labels and SVG text are content and get translated; the package's
 * titles, descriptions and subjects are metadata and stay untouched.
 */
export const TRANSLATABLE_ATTRIBUTES: Record<string, string[]> = {
  "*": ["title", "aria-label"],
  img: ["alt"],
  area: ["alt"],
  input: ["alt", "placeholder"],
};

function translatableAttributes(name: string): string[] {
  return [...TRANSLATABLE_ATTRIBUTES["*"], ...(TRANSLATABLE_ATTRIBUTES[name] ?? [])];
}

/** An attribute value waiting for the unit id it will be given. */
interface PendingAttr {
  slot: PlaceholderAttr;
  range: [number, number];
  value: string;
}

interface Content {
  source: string;
  placeholders: Placeholder[];
  pending: PendingAttr[];
  hasText: boolean;
  reliable: boolean;
  supported: boolean;
}

class Extractor {
  input: ExtractInput;
  unitElements: Set<string>;
  units: TranslationUnit[];
  ordinal: number;

  constructor(input: ExtractInput) {
    this.input = input;
    this.unitElements = input.nav === true ? NAV_BLOCKS : BLOCKS;
    this.units = [];
    this.ordinal = 0;
  }

  isUnitElement(name: string): boolean {
    return this.unitElements.has(name) || NEVER_TRANSLATED.has(name);
  }

  hasUnitDescendant(node: ElementNode): boolean {
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      if (this.isUnitElement(child.name) || this.hasUnitDescendant(child)) return true;
    }
    return false;
  }

  /** A child that carries a unit somewhere below it cannot join a loose run. */
  isBoundary(node: Node): boolean {
    if (node.kind === "other") return true;
    if (node.kind !== "element") return false;
    return this.isUnitElement(node.name) || this.hasUnitDescendant(node);
  }

  nextId(): { id: string; ordinal: number } {
    this.ordinal += 1;
    return { id: `${this.input.doc}#${this.ordinal}`, ordinal: this.ordinal };
  }

  /**
   * Masks every inline element as a numbered placeholder. The markers use
   * digits only — `<0>`, `</0>`, `<0/>` — so they cannot collide with real
   * markup, and they are numbered in the order the elements open.
   */
  content(children: Node[], into?: Content): Content {
    const out: Content = into ?? {
      source: "",
      placeholders: [],
      pending: [],
      hasText: false,
      reliable: true,
      supported: true,
    };

    for (const child of children) {
      if (child.kind === "text") {
        out.source += child.text;
        if (child.text.trim().length > 0) out.hasText = true;
        if (!child.reliable) out.reliable = false;
        continue;
      }
      if (child.kind !== "element") {
        out.supported = false;
        continue;
      }
      if (!child.reliable) out.reliable = false;

      const index = out.placeholders.length;
      const open = this.input.source.slice(child.openStart, child.openEnd);
      const opaque = OPAQUE.has(child.name);
      const placeholder: Placeholder = {
        index,
        open,
        close: child.selfClosing ? "" : this.input.source.slice(child.closeStart, child.closeEnd),
        opaque,
      };
      out.placeholders.push(placeholder);

      if (!isPageMarker(child)) {
        for (const name of translatableAttributes(child.name)) {
          const attr = child.attrs.find((a) => a.name === name);
          if (!attr || attr.value.trim().length === 0) continue;
          const slot: PlaceholderAttr = { unitId: "", start: attr.start, end: attr.end };
          (placeholder.attrs ??= []).push(slot);
          out.pending.push({
            slot,
            range: [child.openStart + attr.start, child.openStart + attr.end],
            value: attr.value,
          });
        }
      }

      if (child.selfClosing) {
        out.source += `<${index}/>`;
        continue;
      }
      if (opaque) {
        // Two copies. `content` carries the markers of anything nested inside;
        // `rawContent` is what the source wrote, and re-emitting it is what
        // keeps `&#8230;` from coming back as three literal dots.
        const inner = this.content(child.children, {
          source: "",
          placeholders: out.placeholders,
          pending: out.pending,
          hasText: false,
          reliable: out.reliable,
          supported: out.supported,
        });
        placeholder.content = inner.source;
        placeholder.rawContent = this.input.source.slice(child.openEnd, child.closeStart);
        out.reliable = inner.reliable;
        out.supported = inner.supported;
        if (inner.hasText) out.hasText = true;
        out.source += `<${index}></${index}>`;
        continue;
      }

      out.source += `<${index}>`;
      this.content(child.children, out);
      out.source += `</${index}>`;
    }
    return out;
  }

  stateOf(
    node: ElementNode | null,
    frame: Frame,
    content: Content,
  ): { state: UnitState; reason?: string } {
    if (node && NEVER_TRANSLATED.has(node.name)) return { state: "never-translated" };
    if (frame.translateNo) return { state: "translate-no" };
    if (node && CODE_ELEMENTS.has(node.name)) return { state: "code" };
    const surfaces = this.input.codeSurfaces;
    if (node && surfaces) {
      for (const name of classesOf(node)) {
        if (surfaces.has(name)) return { state: "code", reason: "css-code-surface" };
      }
    }
    if (!content.reliable) return { state: "uncomposable", reason: "unreliable-range" };
    if (!content.supported) return { state: "uncomposable", reason: "unsupported-content" };
    return { state: "translate" };
  }

  emit(
    kind: UnitKind,
    node: ElementNode | null,
    children: Node[],
    range: [number, number],
    frame: Frame,
  ): void {
    const content = this.content(children);
    if (!content.hasText && content.pending.length === 0) return;

    const { id, ordinal } = this.nextId();
    const { state, reason } = this.stateOf(node, frame, content);
    this.units.push({
      id,
      kind,
      doc: this.input.doc,
      ordinal,
      range,
      source: content.source,
      raw: this.input.source.slice(range[0], range[1]),
      state,
      ...(reason === undefined ? {} : { reason }),
      placeholders: content.placeholders,
      ...(node === null ? {} : { element: node.name }),
      ...(node === null || classesOf(node)[0] === undefined ? {} : { className: classesOf(node)[0] }),
    });

    // The attribute units come after the block that owns them, so an id is
    // never referenced before it exists.
    for (const attr of content.pending) {
      const next = this.nextId();
      attr.slot.unitId = next.id;
      this.units.push({
        id: next.id,
        kind: "attribute",
        doc: this.input.doc,
        ordinal: next.ordinal,
        range: attr.range,
        source: attr.value,
        raw: this.input.source.slice(attr.range[0], attr.range[1]),
        state: state === "translate" ? "translate" : state,
        ...(reason === undefined ? {} : { reason }),
        owner: id,
      });
    }
  }

  /**
   * `runs` says whether bare text among this element's children becomes a unit
   * of its own. Only a block container answers yes: a run formed inside `html`
   * would swallow the head.
   */
  walk(children: Node[], frame: Frame, runs: boolean): void {
    let run: Node[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const first = run[0];
      const last = run[run.length - 1];
      this.emit("text", null, run, [startOf(first), endOf(last)], frame);
      run = [];
    };

    for (const child of children) {
      if (!this.isBoundary(child)) {
        if (runs) run.push(child);
        continue;
      }
      flush();
      if (child.kind !== "element") continue;

      const inner: Frame = {
        translateNo: frame.translateNo || attrValue(child, "translate") === "no",
      };
      if (this.isUnitElement(child.name) && !this.hasUnitDescendant(child)) {
        const range: [number, number] = [child.openEnd, child.closeStart];
        this.emit("block", child, child.children, range, inner);
      } else {
        this.walk(child.children, inner, this.isUnitElement(child.name));
      }
    }
    flush();
  }
}

export function extract(input: ExtractInput): ExtractReport {
  let events: ScanEvent[];
  try {
    events = scan(input.source, input.doc);
  } catch {
    return { units: [], skipped: [{ doc: input.doc, reason: "unreadable", degraded: true }] };
  }

  const roots = toTree(events);
  const html = roots.find((n): n is ElementNode => n.kind === "element");
  if (html && attrValue(html, "translate") === "no") {
    return { units: [], skipped: [{ doc: input.doc, reason: "translate-no", degraded: false }] };
  }

  const extractor = new Extractor(input);
  extractor.walk(roots, { translateNo: false }, false);
  return { units: extractor.units, skipped: [] };
}
