import { nullSink, type LlmBackend, type LogSink, type ProgressSink } from "../ports.ts";
import type { TranslationUnit } from "../epub/index.ts";
import { batchUnits, buildCodePrompt, parseCodeVerdict } from "./code-wire.ts";
import type { CodeBatch } from "./code-wire.ts";

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
  /** Batches are independent, so they go out as wide as the run allows. */
  concurrency?: number;
  signal?: AbortSignal;
  /** Absent in the tests that only care about the verdicts. */
  progress?: ProgressSink;
  /** The run's chronicle, when there is one to write to. */
  log?: LogSink;
}

const ATTEMPTS = 3;

/** The only deduction soft enough to be overruled: a guess made from a stylesheet. */
const FROM_CSS = "css-code-surface";

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
  const log = input.log ?? nullSink;
  const questionable = input.units.filter((unit) =>
    unit.state === "translate" || (unit.state === "code" && unit.reason === FROM_CSS));

  const marked: string[] = [];
  const freed: string[] = [];
  let abstained = 0;

  const batches = batchUnits(questionable, input.batchSize);
  const judge = async (batch: CodeBatch): Promise<void> => {
    let retryReason: string | undefined;

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      input.signal?.throwIfAborted();
      const began = Date.now();
      const result = await input.backend.call({
        prompt: buildCodePrompt(batch, retryReason),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      log.record({
        level: "debug",
        code: "batch-finished",
        detail: {
          phase: "code-index",
          batch: batch.index,
          of: batch.total,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          reasoningTokens: result.reasoningTokens,
          finishReason: result.finishReason,
          elapsedMs: Date.now() - began,
        },
      });

      const verdict = parseCodeVerdict(result.text, batch);
      if (!verdict.ok) {
        // Carried into the next attempt. A model told what was wrong with its
        // last answer fixes it; a model asked again, identically, answers
        // identically, and the batch burns its whole budget saying so.
        retryReason = verdict.reason;
        continue;
      }

      for (const unit of batch.units) {
        if (unit.state === "translate" && verdict.code.has(unit.id)) marked.push(unit.id);
        if (unit.state === "code" && verdict.prose.has(unit.id)) freed.push(unit.id);
      }
      return;
    }

    abstained++;
  };

  const width = Math.max(1, input.concurrency ?? 2);
  let judged = 0;
  for (let at = 0; at < batches.length; at += width) {
    input.signal?.throwIfAborted();
    await Promise.all(batches.slice(at, at + width).map(async (batch) => {
      await judge(batch);
      judged++;
      input.progress?.report({ phase: "code-index", done: judged, total: batches.length });
    }));
  }

  // Sorted before they leave. The batches finish in whatever order the network
  // returns them, and this list becomes a checkpoint: an order that changes
  // between two identical runs would make the record of one unreadable against
  // the other.
  marked.sort();
  freed.sort();
  return { marked, freed, abstained, sourceHash: input.sourceHash };
}
