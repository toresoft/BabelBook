import { isWork, type TranslationUnit } from "../epub/index.ts";

/** Roughly a page of prose: enough to judge a book by, cheap enough to send three times. */
const MAX_CHARS_PER_SAMPLE = 2000;

/**
 * A few contiguous passages, taken from parts of the book that are far apart.
 *
 * Everything downstream treats these as independent evidence: the domain vote
 * takes a majority of them, and the term extraction merges what they turn up.
 * Three samples drawn from the same chapter say the same thing three times,
 * and a majority over them means nothing — so the distance between them is the
 * property that matters, not the size.
 *
 * Only work units are sampled. Code and untranslated surfaces say nothing
 * about the book's subject, and a sample full of them would push the vote
 * towards whatever the markup happens to contain.
 */
export function sampleBlocks(units: TranslationUnit[], count = 3): string[][] {
  const work = units.filter((unit) => isWork(unit.state));
  if (work.length === 0) return [];

  const wanted = Math.min(count, work.length);
  const bandSize = work.length / wanted;
  const samples: string[][] = [];

  for (let band = 0; band < wanted; band++) {
    // From the middle of the band: the opening and closing pages of a book are
    // front matter and colophon more often than they are the book.
    const centre = Math.floor(band * bandSize + bandSize / 2);
    const start = Math.min(centre, work.length - 1);

    const sample: string[] = [];
    let chars = 0;
    for (let at = start; at < work.length; at++) {
      const text = work[at].source;
      if (sample.length > 0 && chars + text.length > MAX_CHARS_PER_SAMPLE) break;
      sample.push(text);
      chars += text.length;
      if (chars >= MAX_CHARS_PER_SAMPLE) break;
    }
    samples.push(sample);
  }

  return samples;
}
