/**
 * A term the translation must honour.
 *
 * It lives here rather than in `ports.ts` because the glossary owns the
 * vocabulary; the ports only carry it. `index.ts` re-exports this once the
 * parsing layer exists, so consumers have one place to import from.
 */
export interface TermEntry {
  source: string;
  /** Absent for a `dnt` rule: there is nothing to render it as. */
  target?: string;
  rule: "dnt" | "must";
  note?: string;
  origin: "glossary" | "extracted" | "manual";
}
