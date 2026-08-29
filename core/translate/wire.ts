import { isWork } from "../epub/index.ts";
import { buildSystem, languageName } from "./instructions.ts";
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
/**
 * Everything a chunk carries before its units: the chapter, the book, the
 * terminology, the text around it.
 *
 * Shared by both contracts, because none of it is about how the answer comes
 * back. Only the closing instruction and the wrapper differ.
 */
export function preamble(request: TranslationRequest): string[] {
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
  return lines;
}

/** Every unit of the chunk, each behind the marker that names it. */
export function unitLines(request: TranslationRequest): string[] {
  return request.units.flatMap((unit) => [`[u:${unit.id}]`, unit.source]);
}

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

  const lines = [...preamble(request)];
  const { context } = request;
  // The language is named here and not only in the instructions: this is the
  // last line before the work, and the last line is where a model looks when
  // it starts writing. Version 2 said only "translate the units below", 1600
  // characters after the only mention of the target language.
  lines.push("", `Translate the ${request.units.length} units below into `
    + `${languageName(context.targetLanguage)}.`,
    "Answer with the same markers, in the same order, and finish with END.", "");
  lines.push(`UNITS ${request.units.length}`, ...unitLines(request), TERMINATOR);

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
  const header = lines.findIndex((line) => HEADER.test(line.trim()));

  // The header anchors the block when it is there, and the first marker
  // anchors it when it is not. A model that copies every marker, closes with
  // END and translates correctly has not failed to answer because it left out
  // a count — and discarding that answer whole costs three paid attempts and
  // a chapter of the book, which is what it cost before this line existed.
  const first = lines.findIndex((line) => MARKER.test(line.trim()));
  if (header === -1 && first === -1) return { declared: null, lines: [], terminated: false };

  const start = header === -1 ? first - 1 : header;
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

  // Nothing declared, nothing to disagree with: the count becomes what
  // arrived, so level 2 stands down and level 4 reports what is missing, unit
  // by unit, which is the more useful answer anyway.
  const declared = header === -1
    ? parsed.length
    : Number(HEADER.exec(lines[header]!.trim())![1]);

  return { declared, lines: parsed, terminated: end !== -1 };
}
