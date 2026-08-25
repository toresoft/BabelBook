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
