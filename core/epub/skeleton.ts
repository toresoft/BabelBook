import type { TranslationUnit } from "./blocks.ts";
import { EpubError } from "../errors.ts";

export class SkeletonError extends EpubError {
  constructor(message: string, code: string = "SKELETON_MISMATCH") {
    super(message, code);
  }
}

export interface Skeleton {
  text: string;
  open: string;
  close: string;
}

export interface FillResult {
  text: string;
  filled: number;
}

/**
 * Tried in order. The last pair is built from control characters no XHTML
 * document carries legitimately; it exists so the choice cannot run out.
 */
const DELIMITERS: Array<{ open: string; close: string }> = [
  { open: "⟦u:", close: "⟧" },
  { open: "⦃u:", close: "⦄" },
  { open: "\u0001u:", close: "\u0002" },
];

/** Only root units are replaced: an attribute's range lives inside its owner's. */
function rootUnits(units: TranslationUnit[]): TranslationUnit[] {
  return units
    .filter((u) => u.owner === undefined)
    .slice()
    .sort((a, b) => a.range[0] - b.range[0]);
}

/**
 * Takes every unit out of the source and leaves a delimiter in its place.
 *
 * The units are checked against this source first. A stale set — from another
 * book, or from before a boundary moved — would slice silently: an empty string
 * here, a truncated one there, and a document rebuilt wrong with nothing said.
 */
export function buildSkeleton(source: string, units: TranslationUnit[]): Skeleton {
  const pair = DELIMITERS.find((d) => !source.includes(d.open) && !source.includes(d.close));
  if (!pair) {
    throw new SkeletonError("every delimiter already occurs in the source", "NO_FREE_DELIMITER");
  }

  const roots = rootUnits(units);
  let text = "";
  let at = 0;

  for (const unit of roots) {
    const [start, end] = unit.range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new SkeletonError(`unit ${unit.id} has an inverted range`, "STALE_UNIT_RANGE");
    }
    if (start < 0 || end > source.length) {
      throw new SkeletonError(`unit ${unit.id} falls outside the source`, "STALE_UNIT_RANGE");
    }
    if (start < at) {
      throw new SkeletonError(`unit ${unit.id} overlaps the unit before it`, "STALE_UNIT_RANGE");
    }
    if (source.slice(start, end) !== unit.raw) {
      throw new SkeletonError(`unit ${unit.id} does not describe this source`, "STALE_UNIT_RANGE");
    }
    if (unit.id.includes(pair.close)) {
      throw new SkeletonError(`unit id ${unit.id} carries the delimiter`, "NO_FREE_DELIMITER");
    }
    text += source.slice(at, start) + pair.open + unit.id + pair.close;
    at = end;
  }
  text += source.slice(at);

  return { text, open: pair.open, close: pair.close };
}

/**
 * Puts the units back.
 *
 * A unit whose rendering equals the original is re-emitted from `raw`. That is
 * not an optimisation: it is what makes an empty fill return the source byte
 * for byte, and therefore what makes the identity gate an assertion instead of
 * a tautology. Rewriting every range would re-escape `&#38;` into `&amp;` —
 * the same to a reader, different to a comparison.
 */
export function fillSkeleton(
  skeleton: Skeleton,
  units: TranslationUnit[],
  rendered: Map<string, string>,
): FillResult {
  const byId = new Map(units.map((u) => [u.id, u]));
  let text = "";
  let at = 0;
  let filled = 0;

  for (;;) {
    const start = skeleton.text.indexOf(skeleton.open, at);
    if (start === -1) break;
    const idAt = start + skeleton.open.length;
    const end = skeleton.text.indexOf(skeleton.close, idAt);
    if (end === -1) {
      throw new SkeletonError("a delimiter in the skeleton is never closed", "BROKEN_SKELETON");
    }

    const id = skeleton.text.slice(idAt, end);
    const unit = byId.get(id);
    if (!unit) {
      throw new SkeletonError(`the skeleton names a unit that is not here: ${id}`, "BROKEN_SKELETON");
    }

    text += skeleton.text.slice(at, start);
    const value = rendered.get(id);
    if (value === undefined || value === unit.raw) {
      text += unit.raw;
    } else {
      text += value;
      filled += 1;
    }
    at = end + skeleton.close.length;
  }

  text += skeleton.text.slice(at);
  return { text, filled };
}
