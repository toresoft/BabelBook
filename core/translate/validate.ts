import type { TranslationUnit } from "../epub/index.ts";
import { parseResponse } from "./wire.ts";

export type RejectionCode =
  | "no-structure"          // level 1: no header, nothing to read
  | "count-mismatch"        // level 2: fewer or more units than declared
  | "empty-text"            // level 3: a unit came back with nothing in it
  | "marker-residue"        // level 3: a protocol marker inside a translation
  | "unknown-id"            // level 4: an id nobody asked for
  | "duplicate-id"          // level 4: the same unit answered twice
  | "missing-id"            // level 4: a requested unit never came back
  | "placeholder-mismatch"; // level 5: the markup did not survive

export interface Rejection {
  /** Null when the fault is the answer's as a whole. */
  unitId: string | null;
  code: RejectionCode;
  detail: string;
}

export interface Validation {
  /** Unit id to translated text, for everything that passed all five levels. */
  accepted: Map<string, string>;
  rejections: Rejection[];
  /** The answer stopped because it ran out of output budget. */
  truncated: boolean;
}

const MARKER_RESIDUE = /\[u:[^\]]+\]/;

/** The numbered placeholders a text carries, in the order they open. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/<(\/?)(\d+)(\/?)>/g)].map((match) => match[0]);
}

/**
 * Whether the markup survived the translation.
 *
 * The comparison is on the multiset of markers, not on their order: a
 * translation is allowed — often required — to move an emphasis to where the
 * target language wants it. What it may not do is drop one, invent one, or
 * leave a pair unbalanced, because each of those makes the unit uncomposable.
 */
function placeholdersSurvived(source: string, translated: string): string | null {
  const before = placeholders(source).sort();
  const after = placeholders(translated).sort();

  if (before.join(",") !== after.join(",")) {
    return `expected ${before.join(" ") || "none"}, got ${after.join(" ") || "none"}`;
  }

  const open = new Map<string, number>();
  for (const marker of placeholders(translated)) {
    const parsed = /<(\/?)(\d+)(\/?)>/.exec(marker)!;
    if (parsed[3] === "/") continue;                      // self-contained
    const index = parsed[2];
    const delta = parsed[1] === "/" ? -1 : 1;
    const depth = (open.get(index) ?? 0) + delta;
    if (depth < 0) return `placeholder ${index} closes before it opens`;
    open.set(index, depth);
  }
  for (const [index, depth] of open) {
    if (depth !== 0) return `placeholder ${index} is left open`;
  }
  return null;
}

/**
 * A chunk's answer, held to five levels.
 *
 * Each level stops what it catches and keeps everything else: a retry that
 * resent the whole chunk would pay again for units that were already right,
 * and would keep paying every time one unit in twenty came back wrong.
 *
 * Level 4 is the one that matters most. Ids are matched, never positions: an
 * answer whose units are plausible but shifted by one reads as a good
 * translation and puts every sentence in the wrong place.
 */
export function validate(
  raw: string,
  requested: TranslationUnit[],
  finishReason: "stop" | "length" | "other",
): Validation {
  const truncated = finishReason === "length";
  const parsed = parseResponse(raw);
  const rejections: Rejection[] = [];

  // Level 1 — structure.
  if (parsed.declared === null) {
    return {
      accepted: new Map(),
      rejections: [{ unitId: null, code: "no-structure", detail: "no UNITS header in the answer" }],
      truncated,
    };
  }

  // Level 2 — extraction. A truncated answer is short by definition, and
  // saying so twice would send the same chunk back for two reasons at once.
  if (parsed.lines.length !== parsed.declared && !truncated) {
    rejections.push({
      unitId: null,
      code: "count-mismatch",
      detail: `declared ${parsed.declared}, found ${parsed.lines.length}`,
    });
  }

  const wanted = new Map(requested.map((unit) => [unit.id, unit]));
  const seen = new Map<string, number>();
  for (const line of parsed.lines) {
    seen.set(line.unitId, (seen.get(line.unitId) ?? 0) + 1);
  }

  const accepted = new Map<string, string>();

  for (const line of parsed.lines) {
    const unit = wanted.get(line.unitId);

    // Level 4 — the exact id set.
    if (unit === undefined) {
      rejections.push({
        unitId: line.unitId, code: "unknown-id", detail: "this unit was not requested",
      });
      continue;
    }
    if ((seen.get(line.unitId) ?? 0) > 1) {
      if (!rejections.some((r) => r.code === "duplicate-id" && r.unitId === line.unitId)) {
        rejections.push({
          unitId: line.unitId, code: "duplicate-id", detail: "answered more than once",
        });
      }
      continue;
    }

    // Level 3 — decoding.
    if (line.text === "") {
      rejections.push({ unitId: line.unitId, code: "empty-text", detail: "nothing came back" });
      continue;
    }
    if (MARKER_RESIDUE.test(line.text)) {
      rejections.push({
        unitId: line.unitId, code: "marker-residue", detail: "a protocol marker is inside the text",
      });
      continue;
    }

    // Level 5 — placeholders.
    const damage = placeholdersSurvived(unit.source, line.text);
    if (damage !== null) {
      rejections.push({ unitId: line.unitId, code: "placeholder-mismatch", detail: damage });
      continue;
    }

    accepted.set(line.unitId, line.text);
  }

  // Level 4, the other direction: what was asked for and never came back.
  // A truncated answer explains its own gaps, and reporting them as missing
  // would drown the one fact that matters — that the budget ran out.
  if (!truncated) {
    for (const unit of requested) {
      if (!seen.has(unit.id)) {
        rejections.push({ unitId: unit.id, code: "missing-id", detail: "never came back" });
      }
    }
  }

  return { accepted, rejections, truncated };
}
