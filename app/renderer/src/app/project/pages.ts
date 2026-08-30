/** The gap between two runs of page numbers, as the pager draws it. */
export const GAP = "…";

export type PageItem = number | typeof GAP;

/**
 * The page numbers a pager shows: the first, the last, the current with a
 * neighbour on each side, and a gap where numbers were left out.
 *
 * Seven or fewer pages are all shown — a gap that hides one number is longer
 * than the number it hides. Above that the list has a fixed width, so the
 * buttons do not move under the pointer as the pages go by.
 */
export function pageItems(current: number, pages: number): PageItem[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, at) => at + 1);

  const items: PageItem[] = [1];
  if (current > 3) items.push(GAP);
  for (let page = Math.max(2, current - 1); page <= Math.min(pages - 1, current + 1); page++) {
    items.push(page);
  }
  if (current < pages - 2) items.push(GAP);
  items.push(pages);
  return items;
}
