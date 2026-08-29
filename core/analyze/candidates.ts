import type { LlmBackend, ProgressSink } from "../ports.ts";
import type { TermEntry } from "../glossary/index.ts";
import { isWork, type TranslationUnit } from "../epub/index.ts";
import { languageName } from "../translate/instructions.ts";
import { foreignScript } from "../translate/script.ts";
import { sampleBlocks } from "./sample.ts";

export interface Candidate extends TermEntry {
  origin: "extracted";
  /** Counted in the book, so the interface can show what a decision is worth. */
  occurrences: number;
  /** The first sentence the term appears in, for the user to decide by. */
  context: string;
  approval: "pending" | "approved" | "rejected";
}

export interface OpenQuestion {
  source: string;
  question: string;
}

export interface CandidateReport {
  candidates: Candidate[];
  /**
   * Terms nobody settled: the model said it could not choose, or the samples
   * chose differently. They are declarations, not translation failures — no
   * unapproved terminology is applied, and they do not make a book incomplete.
   */
  open: OpenQuestion[];
  /** Proposed terms the book does not contain. */
  discarded: number;
  /** Every sample came back outside the format. */
  abstained: boolean;
}

export interface ExtractInput {
  units: TranslationUnit[];
  backend: LlmBackend;
  sourceLanguage: string;
  targetLanguage: string;
  /** What the user wrote about the book. */
  description?: string;
  signal?: AbortSignal;
  /** Absent in the tests that only care about the report. */
  progress?: ProgressSink;
}

interface Proposal {
  source: string;
  rule: TermEntry["rule"];
  target?: string;
  note?: string;
}

const TERM_LINE = /^\[t:([^\]]+)\]\s*(.*)$/;
const OPEN_LINE = /^\[o:([^\]]+)\]\s*(.*)$/;
const RULES = new Set(["dnt", "prefer", "must"]);

function buildPrompt(sample: string[], input: ExtractInput): string {
  return [
    // Named, not spelled as a tag. "preparing a en book for translation into
    // it" asks a model to act on two codes, and on a real book it answered
    // with renderings in a third language entirely.
    `You are preparing a ${languageName(input.sourceLanguage)} book`
      + ` for translation into ${languageName(input.targetLanguage)}.`,
    "From the passage below, list the terms a translator must handle consistently:",
    "proper names, invented names, places, brands, and technical terms.",
    "",
    "Answer in exactly this format and nothing else:",
    "",
    "TERMS <count>",
    "[t:<term>] rule=dnt note=<why>",
    `[t:<term>] rule=must target=<required rendering, in ${languageName(input.targetLanguage)}>`,
    `[t:<term>] rule=prefer target=<preferred rendering, in ${languageName(input.targetLanguage)}>`,
    "OPEN <count>",
    "[o:<term>] <the question you could not answer>",
    "END",
    "",
    "Use dnt for a term to leave untouched, must for one whose rendering is fixed,",
    "prefer for one where a rendering is recommended but not obligatory.",
    "Put a term in OPEN rather than guessing when you cannot decide.",
    "The OPEN section may be omitted when there is nothing to ask.",
    ...(input.description === undefined || input.description === ""
      ? []
      : ["", "What the reader says about this book:", input.description]),
    "",
    "Passage:",
    "---",
    sample.join("\n"),
    "---",
  ].join("\n");
}

/**
 * One sample's answer, or nothing.
 *
 * The shape is checked before anything is read out of it: header, terminator,
 * and a declared count that matches what arrived. An answer that is nearly the
 * format is not the format — reading it anyway is how a book acquires
 * terminology nobody wrote.
 */
function parseAnswer(raw: string): { terms: Proposal[]; open: OpenQuestion[] } | null {
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line) => /^TERMS\s+\d+$/.test(line));
  const end = lines.indexOf("END");
  if (start === -1 || end === -1 || end < start) return null;

  const declared = Number(/^TERMS\s+(\d+)$/.exec(lines[start])![1]);
  const body = lines.slice(start + 1, end);

  const terms: Proposal[] = [];
  const open: OpenQuestion[] = [];
  let section: "terms" | "open" = "terms";

  for (const line of body) {
    if (line === "") continue;
    if (/^OPEN\s+\d+$/.test(line)) {
      section = "open";
      continue;
    }

    if (section === "open") {
      const matched = OPEN_LINE.exec(line);
      if (matched === null) return null;
      open.push({ source: matched[1].trim(), question: matched[2].trim() });
      continue;
    }

    const matched = TERM_LINE.exec(line);
    if (matched === null) return null;

    const fields = new Map<string, string>();
    for (const pair of matched[2].matchAll(/(\w+)=([^=]*?)(?=\s+\w+=|$)/g)) {
      fields.set(pair[1], pair[2].trim());
    }

    const rule = fields.get("rule") ?? "";
    if (!RULES.has(rule)) return null;

    const target = fields.get("target");
    // A rendering rule with nothing to render as says nothing, and the
    // glossary would refuse it later: refuse it here, while it is still one
    // sample's answer rather than a book's terminology.
    if (rule !== "dnt" && (target === undefined || target === "")) return null;

    terms.push({
      source: matched[1].trim(),
      rule: rule as TermEntry["rule"],
      ...(target === undefined || target === "" ? {} : { target }),
      ...(fields.get("note") === undefined ? {} : { note: fields.get("note")! }),
    });
  }

  return terms.length === declared ? { terms, open } : null;
}

function sameProposal(a: Proposal, b: Proposal): boolean {
  return a.rule === b.rule && (a.target ?? "") === (b.target ?? "");
}

export async function extractCandidates(input: ExtractInput): Promise<CandidateReport> {
  const samples = sampleBlocks(input.units);
  const work = input.units.filter((unit) => isWork(unit.state));

  const proposals = new Map<string, Proposal[]>();
  const open = new Map<string, string>();
  let answered = 0;
  let asked = 0;

  for (const sample of samples) {
    input.signal?.throwIfAborted();
    const result = await input.backend.call({
      prompt: buildPrompt(sample, input),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    const parsed = parseAnswer(result.text);
    asked++;
    input.progress?.report({ phase: "candidates", done: asked, total: samples.length });
    if (parsed === null) continue;
    answered++;

    for (const term of parsed.terms) {
      proposals.set(term.source, [...(proposals.get(term.source) ?? []), term]);
    }
    for (const question of parsed.open) open.set(question.source, question.question);
  }

  if (answered === 0) {
    return { candidates: [], open: [], discarded: 0, abstained: true };
  }

  const candidates: Candidate[] = [];
  let discarded = 0;

  for (const [source, proposed] of proposals) {
    // Samples that disagree about the same term have not settled it. Picking
    // one of their answers would apply a rule the book's own evidence
    // contradicts, so the question goes to the user instead.
    if (!proposed.every((proposal) => sameProposal(proposal, proposed[0]))) {
      open.set(source, `the samples proposed different rules for "${source}"`);
      continue;
    }

    const occurrences = work.reduce(
      (total, unit) => total + unit.source.split(source).length - 1,
      0,
    );
    // A term the book does not contain cannot be checked and cannot be
    // applied. It is counted rather than shown: a proposal about another book
    // is noise in a list the user has to read one line at a time.
    if (occurrences === 0) {
      discarded++;
      continue;
    }

    const term = proposed[0];

    // A rendering nobody can apply is not a fact, it is a question. An
    // approved `must` in the wrong script is worse than a missing term: it
    // travels into every chunk that contains the source string, as an
    // instruction, and on a real book that is where the ideograms came from.
    const foreign = term.target === undefined
      ? null
      : foreignScript(source, term.target, input.targetLanguage, { minLetters: 1 });
    if (foreign !== null) {
      open.set(source, `the proposed rendering of "${source}" is written in ${foreign},`
        + ` which ${languageName(input.targetLanguage)} is not`);
      continue;
    }

    candidates.push({
      source,
      ...(term.target === undefined ? {} : { target: term.target }),
      rule: term.rule,
      ...(term.note === undefined ? {} : { note: term.note }),
      origin: "extracted",
      occurrences,
      context: work.find((unit) => unit.source.includes(source))!.source,
      approval: "pending",
    });
  }

  return {
    candidates,
    open: [...open].map(([source, question]) => ({ source, question })),
    discarded,
    abstained: false,
  };
}
