import type { TermEntry } from "./types.ts";

export interface Glossary {
  name: string;
  /** Part of the cache key: a glossary that grew is a different question. */
  version: number;
  /** What the domain vote reads to decide whether this glossary applies. */
  description: string;
  sourceLanguage: string;
  targetLanguage: string;
  terms: TermEntry[];
}

export class GlossaryError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(`${code}: ${message}`);
    this.name = "GlossaryError";
    this.code = code;
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const RULES = new Set(["dnt", "must"]);

/**
 * A cell may contain a pipe, escaped. Splitting on every pipe would cut a note
 * like `either \| or` into two columns and shift everything after it, which is
 * the kind of corruption that reads as a wrong glossary rather than as an
 * error.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < line.length; at++) {
    const char = line[at];
    if (char === "\\" && line[at + 1] === "|") {
      cell += "|";
      at++;
    } else if (char === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  // A markdown row opens and closes with a pipe, so the first and last cells
  // are the empty strings on either side of it.
  return cells.slice(1, -1).map((text) => text.trim());
}

function escapeCell(text: string): string {
  return text.replaceAll("|", String.raw`\|`);
}

/**
 * Frontmatter, read as the flat key-value list it is.
 *
 * No YAML library: the file is written and reviewed by hand, and the shape is
 * a handful of keys. Two forms from the prototype's own glossaries have to be
 * understood — a folded `>` block whose continuation lines are indented, and a
 * one-line list — and everything else is carried through as text. Unknown keys
 * are kept, not rejected: the prototype wrote `layer`, `approved`, `license`
 * and more, and refusing a file over a key we have no use for would break the
 * compatibility this format exists for.
 */
function readFrontmatter(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  let folding: string | null = null;

  for (const line of block.split(/\r?\n/)) {
    const indented = /^\s/.test(line) && line.trim() !== "";

    if (folding !== null && indented) {
      fields.set(folding, `${fields.get(folding)} ${line.trim()}`.trim());
      continue;
    }
    folding = null;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const cut = line.indexOf(":");
    if (cut === -1) {
      throw new GlossaryError(`not a key and a value: ${line}`, "BAD_FRONTMATTER");
    }
    const key = line.slice(0, cut).trim();
    const value = line.slice(cut + 1).trim();

    if (value === ">" || value === "|") {
      fields.set(key, "");
      folding = key;
      continue;
    }
    fields.set(key, value);
  }
  return fields;
}

/**
 * The language pair, however the file states it.
 *
 * The prototype wrote `languages: ["en>it"]`; the shorter form is two keys.
 * Both say the same thing, and a glossary is not worth rewriting over which
 * one its author picked.
 */
function readLanguages(fields: Map<string, string>): { source: string; target: string } {
  const source = fields.get("sourceLanguage");
  const target = fields.get("targetLanguage");
  if (source !== undefined && target !== undefined && source !== "" && target !== "") {
    return { source, target };
  }

  const list = fields.get("languages") ?? "";
  const pair = /([A-Za-z-]+)\s*>\s*([A-Za-z-]+)/.exec(list);
  if (pair === null) {
    throw new GlossaryError(
      'no language pair: expected sourceLanguage and targetLanguage, or languages: ["en>it"]',
      "MISSING_LANGUAGES",
    );
  }
  return { source: pair[1], target: pair[2] };
}

/** Column positions by header name: an extra column must shift nothing. */
function readHeader(cells: string[]): Map<string, number> {
  const columns = new Map<string, number>();
  cells.forEach((cell, at) => columns.set(cell.toLowerCase(), at));
  return columns;
}

export function parseGlossary(markdown: string): Glossary {
  const matched = FRONTMATTER.exec(markdown);
  if (matched === null) {
    throw new GlossaryError("a glossary opens with a --- frontmatter block", "NO_FRONTMATTER");
  }

  const fields = readFrontmatter(matched[1]);
  for (const key of ["name", "description"] as const) {
    if ((fields.get(key) ?? "") === "") {
      throw new GlossaryError(`missing "${key}"`, "MISSING_FIELD");
    }
  }
  const languages = readLanguages(fields);

  const rawVersion = fields.get("version") ?? "";
  const version = Number(rawVersion);
  // The version enters the cache key. Without one there is no way to tell
  // "same question, keep the answer" from "new question, ask again".
  if (rawVersion === "" || !Number.isInteger(version) || version < 1) {
    throw new GlossaryError(`version must be a positive integer, got "${rawVersion}"`, "BAD_VERSION");
  }

  const rows = markdown.slice(matched[0].length).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));

  let columns: Map<string, number> | null = null;
  const terms: TermEntry[] = [];

  for (const row of rows) {
    const cells = splitRow(row);
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;            // separator

    if (columns === null) {
      if (cells[0]?.toLowerCase() !== "source") {
        throw new GlossaryError("the term table starts with a header naming its columns", "NO_HEADER");
      }
      columns = readHeader(cells);
      continue;
    }

    const at = (name: string) => {
      const index = columns!.get(name);
      return index === undefined ? "" : (cells[index] ?? "");
    };

    const source = at("source");
    if (source === "") continue;

    const rule = at("rule");
    if (!RULES.has(rule)) {
      throw new GlossaryError(
        `"${source}" has rule "${rule}"; known rules are ${[...RULES].join(", ")}`,
        "UNKNOWN_RULE",
      );
    }

    const target = at("target");
    if (rule === "must" && target === "") {
      throw new GlossaryError(`"${source}" is a must rule with no rendering`, "MISSING_TARGET");
    }

    const sense = at("sense");
    const note = at("note");

    terms.push({
      source,
      ...(target === "" ? {} : { target }),
      rule: rule as TermEntry["rule"],
      ...(sense === "" ? {} : { sense }),
      ...(note === "" ? {} : { note }),
      origin: "glossary",
    });
  }

  return {
    name: fields.get("name")!,
    version,
    description: fields.get("description")!,
    sourceLanguage: languages.source,
    targetLanguage: languages.target,
    terms,
  };
}

export function serializeGlossary(glossary: Glossary): string {
  const head = [
    "---",
    `name: ${glossary.name}`,
    `version: ${glossary.version}`,
    `description: ${glossary.description}`,
    `sourceLanguage: ${glossary.sourceLanguage}`,
    `targetLanguage: ${glossary.targetLanguage}`,
    "---",
    "",
    "| source | target | rule | sense | note |",
    "|---|---|---|---|---|",
  ];

  const rows = glossary.terms.map((term) =>
    `| ${escapeCell(term.source)} | ${escapeCell(term.target ?? "")} | ${term.rule} `
    + `| ${escapeCell(term.sense ?? "")} | ${escapeCell(term.note ?? "")} |`);

  return [...head, ...rows, ""].join("\n");
}
