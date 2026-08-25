import { isWork } from "../epub/index.ts";
import { buildSystem } from "./instructions.ts";
import type { ParsedResponse, TranslationRequest } from "./types.ts";

export { buildSystem };

const HEADER = /^UNITS\s+(\d+)\s*$/;
const MARKER = /^\[u:([^\]]+)\]\s*$/;
const TERMINATOR = "END";

/**
 * The request, in the shape the answer must come back in.
 *
 * Three properties do the work, and each one feeds a level of validation:
 * the **declared count** makes a partial answer visible; the **explicit
 * marker** makes it impossible to align by position; the **terminator**
 * separates a finished answer from a truncated one.
 */
export function buildPayload(request: TranslationRequest): string {
  if (request.units.length === 0) {
    throw new Error("buildPayload: nothing to translate");
  }
  // The planner decides what is work. A guard here means a defect upstream
  // cannot end up paying a model to translate code.
  for (const unit of request.units) {
    if (!isWork(unit.state)) {
      throw new Error(`buildPayload: ${unit.id} is ${unit.state}, not work`);
    }
  }

  const lines: string[] = [];
  const { context, terms } = request;

  lines.push(`Chapter ${context.chapter.position} of ${context.chapter.total}.`);
  if (context.description !== undefined && context.description !== "") {
    lines.push("", "About this book:", context.description);
  }
  if (context.bookSummary !== undefined && context.bookSummary !== "") {
    lines.push("", "Summary so far:", context.bookSummary);
  }

  if (terms.length > 0) {
    lines.push("", "Terminology:");
    for (const term of terms) {
      lines.push(term.rule === "dnt"
        ? `- ${term.source}: leave untranslated (dnt)${term.note === undefined ? "" : ` — ${term.note}`}`
        : `- ${term.source}: render as "${term.target}" (${term.rule})`
          + `${term.note === undefined ? "" : ` — ${term.note}`}`);
    }
  }

  // Context first, and clearly outside the block: it is there to be read, and
  // a model that translated it would return units nobody asked for.
  if (context.before.length > 0) {
    lines.push("", "Text before, for context only, do not translate:", ...context.before);
  }
  if (context.after.length > 0) {
    lines.push("", "Text after, for context only, do not translate:", ...context.after);
  }
  if (context.interleaved.length > 0) {
    lines.push("", "Text between the units below, for context only, do not translate:",
      ...context.interleaved);
  }

  lines.push("", `Translate the ${request.units.length} units below.`,
    "Answer with the same markers, in the same order, and finish with END.", "");
  lines.push(`UNITS ${request.units.length}`);
  for (const unit of request.units) {
    lines.push(`[u:${unit.id}]`, unit.source);
  }
  lines.push(TERMINATOR);

  return lines.join("\n");
}

/**
 * What came back, read without trusting it.
 *
 * Chatter around the block is ignored, because models add it and refusing the
 * whole answer over a courtesy line would cost a retry for nothing. Everything
 * inside the block is reported as it is: judging it belongs to `validate.ts`,
 * and a reader that also judged would have to decide what to hide.
 */
export function parseResponse(raw: string): ParsedResponse {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADER.test(line.trim()));
  if (start === -1) return { declared: null, lines: [], terminated: false };

  const declared = Number(HEADER.exec(lines[start].trim())![1]);
  const end = lines.findIndex((line, at) => at > start && line.trim() === TERMINATOR);
  const body = lines.slice(start + 1, end === -1 ? undefined : end);

  const parsed: ParsedResponse["lines"] = [];
  let current: string | null = null;
  let text: string[] = [];

  const flush = () => {
    if (current !== null) parsed.push({ unitId: current, text: text.join("\n").trim() });
  };

  for (const line of body) {
    const marker = MARKER.exec(line.trim());
    if (marker !== null) {
      flush();
      current = marker[1].trim();
      text = [];
      continue;
    }
    if (current !== null) text.push(line);
  }
  flush();

  return { declared, lines: parsed, terminated: end !== -1 };
}
