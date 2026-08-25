import type { ZipEntry } from "./zip.ts";

/**
 * Faces a book uses when it means "this is code". The list is short on purpose:
 * a guess that is wrong here silently stops a chapter from being translated.
 */
const MONOSPACE_FACES = [
  "monospace",
  "courier",
  "consolas",
  "menlo",
  "monaco",
  "dejavu sans mono",
  "liberation mono",
  "andale mono",
];

/** `.name` in a selector, with the CSS escape for a leading digit left out. */
function classPattern(): RegExp {
  return /\.(-?[_a-zA-Z][-_a-zA-Z0-9]*)/g;
}

function declaresMonospace(declarations: string): boolean {
  const family = /font-family\s*:([^;}]*)/i.exec(declarations);
  if (!family) return false;
  const value = family[1].toLowerCase();
  return MONOSPACE_FACES.some((face) => value.includes(face));
}

/**
 * The classes the book's stylesheets treat as code surfaces.
 *
 * `white-space: pre` alone is not enough: it dresses poetry and playscripts as
 * often as it dresses code, and reading it as code means leaving verse
 * untranslated. A monospaced font is the signal that holds.
 *
 * This is a suggestion, not an authority: it decides an initial state, and the
 * model may contradict it later. Malformed CSS is ignored, never fatal.
 */
export function archiveCodeSurfaces(entries: ZipEntry[]): Set<string> {
  const surfaces = new Set<string>();

  for (const entry of entries) {
    if (!entry.path.toLowerCase().endsWith(".css")) continue;

    let text: string;
    try {
      text = entry.bytes.toString("utf8");
    } catch {
      continue;
    }

    // No CSS parser: strip comments, then read `selectors { declarations }`
    // pairs. Anything that does not fit that shape is skipped in silence.
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, " ");
    const rules = /([^{}]+)\{([^{}]*)\}/g;
    let rule: RegExpExecArray | null;
    while ((rule = rules.exec(stripped)) !== null) {
      const selectors = rule[1];
      if (selectors.includes("@")) continue;
      if (!declaresMonospace(rule[2])) continue;
      const classes = classPattern();
      let found: RegExpExecArray | null;
      while ((found = classes.exec(selectors)) !== null) surfaces.add(found[1]);
    }
  }

  return surfaces;
}
