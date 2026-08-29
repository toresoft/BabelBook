import { decodeEntities } from "../../../core/epub/index.ts";

/**
 * A unit as a person reads it on screen.
 *
 * Never as HTML. The result goes into a text node in the window, so a book
 * that contains markup shows its markup rather than running it.
 */
export function displayText(rawText: string | null, sourceText: string): string {
  if (rawText === null) return sourceText;
  const withoutTags = rawText.replace(/<[^>]*>/g, "");
  return decodeEntities(withoutTags).replace(/\r\n/g, "\n").trim();
}
