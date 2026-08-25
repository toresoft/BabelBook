import type { Placeholder, TranslationUnit } from "./blocks.ts";
import { EpubError } from "./errors.ts";
import { escapeAttr, escapeText } from "./scan.ts";

export class SpliceError extends EpubError {
  constructor(message: string, code: string = "PLACEHOLDER_MISMATCH") {
    super(message, code);
  }
}

/**
 * A fresh instance every time. A shared global regular expression keeps its
 * `lastIndex` when a loop is left through an error, and poisons the next unit.
 */
function markerPattern(): RegExp {
  return /<(\/?)(\d+)(\/?)>/g;
}

interface MarkerNode {
  kind: "marker";
  index: number;
  children: RenderNode[];
}

interface TextNode {
  kind: "text";
  value: string;
}

type RenderNode = MarkerNode | TextNode;

function parse(text: string, where: string): RenderNode[] {
  const roots: RenderNode[] = [];
  const stack: MarkerNode[] = [];
  const used = new Set<number>();
  const pattern = markerPattern();

  const push = (node: RenderNode): void => {
    const parent = stack[stack.length - 1];
    (parent ? parent.children : roots).push(node);
  };
  const claim = (index: number): void => {
    if (used.has(index)) {
      throw new SpliceError(`${where} uses placeholder ${index} twice`);
    }
    used.add(index);
  };

  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > at) push({ kind: "text", value: text.slice(at, match.index) });
    at = match.index + match[0].length;

    const index = Number(match[2]);
    const closing = match[1] === "/";
    const empty = match[3] === "/";

    if (closing) {
      const open = stack.pop();
      if (!open || open.index !== index) {
        throw new SpliceError(`${where} closes placeholder ${index} out of order`);
      }
      continue;
    }
    claim(index);
    const node: MarkerNode = { kind: "marker", index, children: [] };
    push(node);
    if (!empty) stack.push(node);
  }
  if (at < text.length) push({ kind: "text", value: text.slice(at) });

  if (stack.length > 0) {
    throw new SpliceError(`${where} leaves placeholder ${stack[stack.length - 1].index} open`);
  }
  return roots;
}

/** Translated values go in from the highest offset down, so the rest stay valid. */
function openTag(placeholder: Placeholder, attrs: Map<string, string>): string {
  const patches = (placeholder.attrs ?? [])
    .filter((a) => attrs.has(a.unitId))
    .slice()
    .sort((a, b) => b.start - a.start);

  let open = placeholder.open;
  for (const patch of patches) {
    open = open.slice(0, patch.start) + escapeAttr(attrs.get(patch.unitId)!) + open.slice(patch.end);
  }
  return open;
}

/** True when something inside this opaque element has to be rewritten. */
function touched(
  placeholder: Placeholder,
  placeholders: Placeholder[],
  attrs: Map<string, string>,
  seen: Set<number>,
): boolean {
  if (seen.has(placeholder.index)) return false;
  seen.add(placeholder.index);
  if ((placeholder.attrs ?? []).some((a) => attrs.has(a.unitId))) return true;

  const pattern = markerPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(placeholder.content ?? "")) !== null) {
    if (match[1] === "/") continue;
    const nested = placeholders[Number(match[2])];
    if (nested && touched(nested, placeholders, attrs, seen)) return true;
  }
  return false;
}

function emit(
  nodes: RenderNode[],
  placeholders: Placeholder[],
  attrs: Map<string, string>,
  where: string,
): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += escapeText(node.value);
      continue;
    }
    const placeholder = placeholders[node.index];
    if (!placeholder) {
      throw new SpliceError(`${where} names placeholder ${node.index}, which does not exist`);
    }
    out += openTag(placeholder, attrs);
    if (placeholder.opaque) {
      // The raw content goes back verbatim unless something nested in it was
      // rewritten: `content` is decoded, and re-escaping it would turn
      // `&#8230;` into three literal dots — the same to a reader, different to
      // the invariant that compares opaque content byte for byte.
      out += touched(placeholder, placeholders, attrs, new Set())
        ? emit(parse(placeholder.content ?? "", where), placeholders, attrs, where)
        : (placeholder.rawContent ?? "");
    } else {
      out += emit(node.children, placeholders, attrs, where);
    }
    out += placeholder.close;
  }
  return out;
}

/**
 * From the translated text, with its placeholders, to the markup that replaces
 * the unit's range. An unknown, unbalanced or repeated placeholder is an error:
 * in plan 2 it becomes a diagnosis handed back to the model with a retry.
 */
export function render(
  unit: TranslationUnit,
  translation: string,
  translatedAttrs?: Map<string, string>,
): string {
  const placeholders = unit.placeholders ?? [];
  const attrs = translatedAttrs ?? new Map<string, string>();
  return emit(parse(translation, unit.id), placeholders, attrs, unit.id);
}
