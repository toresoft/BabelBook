import { isWork, type TranslationUnit } from "../epub/index.ts";
import type { ChunkContext } from "./types.ts";

export interface Chunk {
  units: TranslationUnit[];
  context: ChunkContext;
}

export interface PlanInput {
  /** Every unit of the book, in reading order. */
  units: TranslationUnit[];
  sourceLanguage: string;
  targetLanguage: string;
  bookSummary?: string;
  description?: string;
  maxCharsPerChunk?: number;
  /** How many neighbouring units to send as context, on each side. */
  contextWindow?: number;
  /** Units already translated under the current cache key. */
  done?: Set<string>;
}

/**
 * Measured in characters, not tokens.
 *
 * The core does not know the model's tokenizer and must not: naming one would
 * put a provider inside the provider-agnostic half. The budget is prudent
 * rather than precise — its job is to stay clear of the output limit, not to
 * predict it.
 */
const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_WINDOW = 2;

/**
 * The work, cut into chunks a model can answer in one go.
 *
 * Two rules shape every cut. A chunk never crosses a document, because the
 * context window is only meaningful inside one chapter and the ordinal is per
 * document. And a unit is never split: it is the atom, and splitting one would
 * break the placeholders that hold its markup.
 *
 * Units that are not translated stay in the list as context. The chapter is
 * read whole and only the work is sent: a heading nobody translates still
 * explains the paragraph under it.
 */
export function planChunks(input: PlanInput): Chunk[] {
  const maxChars = input.maxCharsPerChunk ?? DEFAULT_MAX_CHARS;
  const window = input.contextWindow ?? DEFAULT_WINDOW;
  const done = input.done ?? new Set<string>();

  const byDoc = new Map<string, TranslationUnit[]>();
  for (const unit of input.units) {
    byDoc.set(unit.doc, [...(byDoc.get(unit.doc) ?? []), unit]);
  }

  const documents = [...byDoc.keys()];
  const chunks: Chunk[] = [];

  documents.forEach((doc, at) => {
    const all = byDoc.get(doc)!;
    const positionOf = new Map(all.map((unit, index) => [unit.id, index]));

    const pending = all.filter((unit) => isWork(unit.state) && !done.has(unit.id));
    if (pending.length === 0) return;

    const groups: TranslationUnit[][] = [];
    let group: TranslationUnit[] = [];
    let chars = 0;

    for (const unit of pending) {
      // A unit alone over budget still gets sent — as its own chunk. Dropping
      // it would lose a paragraph; splitting it would lose its markup.
      if (group.length > 0 && chars + unit.source.length > maxChars) {
        groups.push(group);
        group = [];
        chars = 0;
      }
      group.push(unit);
      chars += unit.source.length;
    }
    if (group.length > 0) groups.push(group);

    for (const units of groups) {
      const first = positionOf.get(units[0].id)!;
      const last = positionOf.get(units[units.length - 1].id)!;
      const sent = new Set(units.map((unit) => unit.id));

      chunks.push({
        units,
        context: {
          sourceLanguage: input.sourceLanguage,
          targetLanguage: input.targetLanguage,
          ...(input.bookSummary === undefined ? {} : { bookSummary: input.bookSummary }),
          ...(input.description === undefined ? {} : { description: input.description }),
          before: all.slice(Math.max(0, first - window), first).map((unit) => unit.source),
          after: all.slice(last + 1, last + 1 + window).map((unit) => unit.source),
          interleaved: all.slice(first, last + 1)
            .filter((unit) => !sent.has(unit.id))
            .map((unit) => unit.source),
          chapter: { doc, position: at + 1, total: documents.length },
        },
      });
    }
  });

  return chunks;
}
