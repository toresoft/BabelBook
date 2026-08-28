/**
 * The settings' four sections, in the order the column offers them.
 *
 * One list, because two copies answer two questions: the column's links and
 * the panels behind them must stay the same four names, and a section added to
 * one and not the other renders a link to an empty screen.
 */
export const SECTIONS = ["providers", "glossaries", "translation", "application"] as const;
export type Section = (typeof SECTIONS)[number];

export const isSection = (value: string): value is Section =>
  (SECTIONS as readonly string[]).includes(value);
