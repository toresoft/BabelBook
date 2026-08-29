import { languageName } from "./instructions.ts";
import type { ParsedResponse, TranslationRequest } from "./types.ts";
import { preamble, unitLines } from "./wire.ts";

/**
 * The answer's shape, imposed instead of asked for.
 *
 * Everything the text contract spends words on — a header, a marker per unit,
 * a terminator, a worked example, and the four paragraphs explaining them — is
 * this object. A provider that enforces a schema cannot return prose, cannot
 * merge two units, and cannot stop halfway without the answer failing to
 * parse; so the instructions no longer have to argue for any of it, and can
 * spend themselves on the translation instead.
 *
 * `additionalProperties: false` throughout: a model that invents a field is
 * inventing structure, and this is the one contract that can say no.
 */
export const TRANSLATION_SCHEMA = {
  type: "object",
  properties: {
    units: {
      type: "array",
      description: "One entry per requested unit, in the order they were given.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The unit's id, copied exactly." },
          text: { type: "string", description: "The translation." },
        },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["units"],
  additionalProperties: false,
} as const;

/**
 * The chunk, for a provider that will impose the shape.
 *
 * The same preamble and the same units as the text contract — none of that is
 * about how the answer comes back — and a closing line that names the language
 * where the work is asked for, which is the one thing the schema cannot say.
 */
export function buildSchemaPayload(request: TranslationRequest): string {
  if (request.units.length === 0) {
    throw new Error("buildSchemaPayload: nothing to translate");
  }

  return [
    ...preamble(request),
    "",
    `Translate the ${request.units.length} units below into `
      + `${languageName(request.context.targetLanguage)}.`,
    "",
    ...unitLines(request),
  ].join("\n");
}

function entry(value: unknown): { unitId: string; text: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, text } = value as { id?: unknown; text?: unknown };
  return typeof id === "string" && typeof text === "string"
    ? { unitId: id, text: text.trim() }
    : null;
}

/**
 * The answer, read into the shape the text parser produces.
 *
 * Deliberately the same `ParsedResponse`: the six levels of `validate` are
 * about what a translation must be, not about how it travelled, and a second
 * validator for the second contract would be two rules for one question.
 *
 * A broken or wrongly shaped answer becomes `declared: null`, which level 1
 * already knows how to refuse — the same answer it gives to prose where a
 * block was asked for. `declared` is the number of entries that survived
 * reading rather than a number the model announced: under this contract there
 * is nothing for it to announce, so level 2 can no longer fire and level 4 is
 * what reports whatever is missing.
 */
export function parseSchemaResponse(raw: string): ParsedResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { declared: null, lines: [], terminated: false };
  }

  const units = (parsed as { units?: unknown })?.units;
  if (!Array.isArray(units)) return { declared: null, lines: [], terminated: false };

  const lines = units.map(entry).filter((line) => line !== null);
  return { declared: lines.length, lines, terminated: true };
}
