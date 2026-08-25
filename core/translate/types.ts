import type { TermEntry } from "../glossary/index.ts";
import type { TranslationUnit } from "../epub/index.ts";

export interface ChunkContext {
  sourceLanguage: string;
  targetLanguage: string;
  /** What the analysis pass understood about the book, when it ran. */
  bookSummary?: string;
  /** What the user wrote about the book. */
  description?: string;
  /** Source text of the units around this chunk: read, never translated. */
  before: string[];
  after: string[];
  /**
   * Untranslated units that sit *between* this chunk's units — a code block
   * between two paragraphs, a surface the author marked `translate="no"`.
   *
   * They are sent because the model needs them to understand what surrounds
   * the prose, and they are sent here rather than by breaking the chunk at
   * each one: measured on a real technical book, 1248 units were code, and a
   * break at every one would turn a few dozen calls into a few thousand.
   * Their position within the chunk is lost, which is the price of that.
   */
  interleaved: string[];
  chapter: { doc: string; position: number; total: number };
}

export interface TranslationRequest {
  /** Work units only; `buildPayload` refuses anything else. */
  units: TranslationUnit[];
  context: ChunkContext;
  terms: TermEntry[];
}

export interface ParsedLine {
  unitId: string;
  text: string;
}

export interface ParsedResponse {
  /** How many units the answer says it carries; null when it says nothing. */
  declared: number | null;
  lines: ParsedLine[];
  terminated: boolean;
}
