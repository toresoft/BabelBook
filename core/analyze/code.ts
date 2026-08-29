import type { LlmBackend, ProgressSink } from "../ports.ts";
import type { TranslationUnit } from "../epub/index.ts";

export interface CodeIndex {
  /** Units that were `translate` and become `maybe-code`. */
  marked: string[];
  /** Units the stylesheet called code and that go back to `translate`. */
  freed: string[];
  /** Batches that never came back in the format. */
  abstained: number;
  /** The source this index describes; it is worthless against another. */
  sourceHash: string;
}

export interface IndexInput {
  units: TranslationUnit[];
  backend: LlmBackend;
  sourceHash: string;
  batchSize?: number;
  signal?: AbortSignal;
  /** Absent in the tests that only care about the verdicts. */
  progress?: ProgressSink;
}

const DEFAULT_BATCH = 20;
const ATTEMPTS = 2;
const VERDICT = /^\[v:([^\]]+)\]\s+(code|prose)\s*$/;

/** The only deduction soft enough to be overruled: a guess made from a stylesheet. */
const FROM_CSS = "css-code-surface";

function buildPrompt(batch: TranslationUnit[]): string {
  return [
    "Below are blocks from a book. For each one, say whether it is code —",
    "a command, a snippet, a console session, program output, a path or an",
    "identifier meant to be typed — or prose, which includes prose that",
    "mentions code in passing.",
    "",
    "Answer in exactly this format and nothing else:",
    "",
    `VERDICTS ${batch.length}`,
    "[v:<unit id>] code",
    "[v:<unit id>] prose",
    "END",
    "",
    "One line per block, in the order they are given, and nothing else.",
    "",
    "Blocks:",
    ...batch.flatMap((unit) => [`[v:${unit.id}]`, unit.source]),
  ].join("\n");
}

function parseVerdicts(raw: string, asked: Set<string>): Map<string, "code" | "prose"> | null {
  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line) => /^VERDICTS\s+\d+$/.test(line));
  const end = lines.indexOf("END");
  if (start === -1 || end === -1 || end < start) return null;

  const declared = Number(/^VERDICTS\s+(\d+)$/.exec(lines[start])![1]);
  const verdicts = new Map<string, "code" | "prose">();

  for (const line of lines.slice(start + 1, end)) {
    if (line === "") continue;
    const matched = VERDICT.exec(line);
    if (matched === null) return null;
    // A verdict about a unit we did not ask about means the answer is not
    // about this batch. Taking the rest of it on trust would apply someone
    // else's judgement to this book.
    if (!asked.has(matched[1])) return null;
    verdicts.set(matched[1], matched[2] as "code" | "prose");
  }

  return verdicts.size === declared ? verdicts : null;
}

/**
 * A second opinion on what is code, from a model that reads the text.
 *
 * It looks at two populations: `translate` units that might be unmarked code,
 * and units the *stylesheet* called code and that might be over-protected
 * prose. Three rules decide how much its opinion is worth.
 *
 * **An abstention never changes a deterministic state.** A batch that stays
 * malformed is counted and nothing moves: a guess about what is code becomes,
 * one step later, a paragraph nobody translated.
 *
 * **What the markup itself declares is not freed.** A `<pre>` is code because
 * the author wrote it that way. Only the inference drawn from a stylesheet —
 * circumstantial by nature — can be overruled.
 *
 * **A suspected unit is forwarded, not withheld.** It becomes `maybe-code`,
 * which is a working state: it goes to the translator with the suspicion
 * attached, and whoever reads it in context decides. Measured on a real book,
 * "the stylesheet is silent and the model says code" is wrong far more often
 * than right — `The src/ directory` is prose with a path in it. Blocking it
 * would be damage; flagging it is help.
 */
export async function indexCodeBlocks(input: IndexInput): Promise<CodeIndex> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH;

  const questionable = input.units.filter((unit) =>
    unit.state === "translate" || (unit.state === "code" && unit.reason === FROM_CSS));

  const marked: string[] = [];
  const freed: string[] = [];
  let abstained = 0;

  const batches: TranslationUnit[][] = [];
  for (let at = 0; at < questionable.length; at += batchSize) {
    batches.push(questionable.slice(at, at + batchSize));
  }

  let judged = 0;
  for (const batch of batches) {
    const asked = new Set(batch.map((unit) => unit.id));

    let verdicts: Map<string, "code" | "prose"> | null = null;
    for (let attempt = 0; attempt < ATTEMPTS && verdicts === null; attempt++) {
      input.signal?.throwIfAborted();
      const result = await input.backend.call({
        prompt: buildPrompt(batch),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      verdicts = parseVerdicts(result.text, asked);
    }

    if (verdicts === null) {
      abstained++;
    } else {
      for (const unit of batch) {
        const verdict = verdicts.get(unit.id);
        if (verdict === undefined) continue;
        if (unit.state === "translate" && verdict === "code") marked.push(unit.id);
        if (unit.state === "code" && verdict === "prose") freed.push(unit.id);
      }
    }

    judged++;
    input.progress?.report({ phase: "code-index", done: judged, total: batches.length });
  }

  return { marked, freed, abstained, sourceHash: input.sourceHash };
}
