import type { TranslationUnit } from "../epub/index.ts";

/**
 * Blocks per batch.
 *
 * Sixty, not twenty. Each line carries the whole block, so a batch is worth
 * roughly three times the tokens of a truncated one — and at twenty, a real
 * technical book is 298 round trips before the first line is translated.
 */
const PER_BATCH = 60;

export interface CodeBatch {
  index: number;
  total: number;
  units: TranslationUnit[];
}

export function batchUnits(units: TranslationUnit[], perBatch: number = PER_BATCH): CodeBatch[] {
  const groups: TranslationUnit[][] = [];
  for (let at = 0; at < units.length; at += perBatch) groups.push(units.slice(at, at + perBatch));
  return groups.map((group, at) => ({ index: at + 1, total: groups.length, units: group }));
}

/**
 * `pre.code`, or `p` — the element and its first class, from the unit itself.
 *
 * From the unit and never from `raw`: a block's `raw` is its CONTENT, so a
 * class read out of it belongs to the first descendant. An attribute or a run
 * of loose text has no element of its own and says which it is instead, which
 * is itself the answer: neither is ever a listing.
 */
function label(unit: TranslationUnit): string {
  const element = unit.element ?? unit.kind;
  return unit.className === undefined ? element : `${element}.${unit.className}`;
}

/** The block, whole, on one line: a listing's own newlines break the format. */
function shown(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildCodePrompt(batch: CodeBatch, retryReason?: string): string {
  const lines = [`#CODEINDEX v1 batch=${batch.index}/${batch.total} count=${batch.units.length}`];
  if (retryReason !== undefined) lines.push("@retry", shown(retryReason));
  lines.push(
    "",
    "You are translating this book. For each line, decide what a translator",
    "would do with it: TRANSLATE it, or KEEP it exactly as it is.",
    "",
    "Keep a line when a translator would retype it verbatim: source code, a",
    "command, console output, a path, an identifier, configuration.",
    "",
    "Translate everything a reader reads as prose — including sentences that",
    "discuss code and are thick with technical terms. `In the previous",
    "snippet, AuthModule imports UsersModule` is a sentence a translator",
    "translates; `imports: [UsersModule]` is one they retype. The question is",
    "not whether the line is ABOUT programming: it is whether it would run.",
    "",
    "Judge the whole line, never the parts inside it. A sentence stays prose",
    "when it names identifiers, quotes a flag or carries a URL: those are",
    "pieces of it, not what it is. Answer keep only when the ENTIRE line is",
    "something they would retype unchanged.",
    "",
    "Reply with one verdict per id, same ids, same order.",
    "",
    "Reply ONLY in this exact format:",
    `#CODEVERDICT v1 batch=${batch.index}/${batch.total} count=${batch.units.length}`,
    " [1] <translate|keep>",
    "@end",
    "",
  );
  batch.units.forEach((unit, at) => {
    lines.push(`[${at + 1}] ${label(unit).padEnd(18)} ${shown(unit.source)}`);
  });
  lines.push("@end");
  return lines.join("\n");
}

const HEADER = /^#CODEVERDICT\s+v1\s+batch=(\d+)\/(\d+)\s+count=(\d+)\s*$/;

/**
 * `keep` means a translator would retype this line unchanged — it is code.
 * `translate` means they would translate it — it is prose.
 *
 * The words are the translator's, not a classifier's, because that is the
 * decision actually being delegated. The older `code|prose` spelling is still
 * accepted: a model answering in the previous vocabulary is out of date, not
 * wrong.
 */
const VERDICT = /^\[(\d+)\]\s+(translate|keep|code|prose)\s*$/;

export function parseCodeVerdict(
  raw: string,
  batch: CodeBatch,
): { ok: true; code: Set<string>; prose: Set<string> } | { ok: false; reason: string } {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADER.test(line.trim()));
  if (start === -1) return { ok: false, reason: "header #CODEVERDICT not found" };

  const header = HEADER.exec(lines[start]!.trim())!;
  const index = Number(header[1]);
  const total = Number(header[2]);
  const count = Number(header[3]);
  if (index !== batch.index || total !== batch.total) {
    return { ok: false, reason: `expected batch ${batch.index}/${batch.total}, found ${index}/${total}` };
  }
  if (count !== batch.units.length) {
    return { ok: false, reason: `expected count ${batch.units.length}, found ${count}` };
  }

  // Searched from the header onward, never from the top: the terminator is the
  // one that closes THIS block, and a block whose text contains the word would
  // otherwise end the parsing before it began.
  const end = lines.findIndex((line, at) => at > start && line.trim() === "@end");
  if (end === -1) return { ok: false, reason: "terminator @end not found" };

  const code = new Set<string>();
  const prose = new Set<string>();
  let expected = 1;

  for (const line of lines.slice(start + 1, end).map((line) => line.trim())) {
    if (line === "") continue;
    const matched = VERDICT.exec(line);
    if (matched === null) return { ok: false, reason: `malformed verdict: ${line}` };

    const local = Number(matched[1]);
    if (local !== expected) return { ok: false, reason: `expected id ${expected}, found ${local}` };

    const unit = batch.units[local - 1];
    if (unit === undefined) return { ok: false, reason: `verdict for unknown id ${local}` };
    (matched[2] === "keep" || matched[2] === "code" ? code : prose).add(unit.id);
    expected++;
  }

  if (expected - 1 !== batch.units.length) {
    return { ok: false, reason: `expected ${batch.units.length} verdicts, found ${expected - 1}` };
  }
  return { ok: true, code, prose };
}
