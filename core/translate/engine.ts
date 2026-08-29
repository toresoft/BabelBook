import type { LlmBackend, LlmResult, ProgressSink, ProjectStore } from "../ports.ts";
import type { TermEntry } from "../glossary/index.ts";
import type { TranslationUnit, UnitState } from "../epub/index.ts";
import { isWork } from "../epub/index.ts";
import { charsBudgetFor, planChunks, type Chunk } from "./plan.ts";
import { termsForChunk } from "./terms.ts";
import { validate, type Rejection, type RejectionCode } from "./validate.ts";
import { buildPayload, buildSystem } from "./wire.ts";

/**
 * What the last attempt came back as, for the units it failed to translate.
 *
 * `exhausted` names two different failures and distinguishes neither: an
 * answer with no structure at all, and one the output budget cut short. Both
 * leave the rejection list without an entry per unit, so both arrive under the
 * same word — and a run that fell back on every unit says only that, which is
 * the point at which reading the code replaces reading the record.
 *
 * These three fields separate them. `reasoningTokens` is the one that names
 * the cause a provider never states: output paid for and spent before the
 * format began.
 */
export interface AnswerDiagnosis {
  finishReason: LlmResult["finishReason"];
  reasoningTokens: number;
  /** The opening of the answer — enough to recognise its shape, not to reprint it. */
  excerpt: string;
}

export interface ChunkOutcome {
  translated: Map<string, string>;
  fellBack: Array<{ unitId: string; reason: RejectionCode | "exhausted" }>;
  attempts: number;
  tokensIn: number;
  tokensOut: number;
  /** Absent only when no call was made, which is to say when nothing was asked. */
  lastAnswer?: AnswerDiagnosis;
}

export interface ChunkInput {
  chunk: Chunk;
  terms: TermEntry[];
  backend: LlmBackend;
  maxAttempts?: number;
  signal?: AbortSignal;
}

const DEFAULT_ATTEMPTS = 3;
/** Enough of an answer to tell a refusal from a preamble from an empty string. */
const EXCERPT_CHARS = 200;

/**
 * What the last attempt got wrong, in words the next one can act on.
 *
 * A retry that resends the same request unchanged is hoping for a luckier
 * sample, and pays full price for the hope. Naming the fault costs a few
 * tokens and changes the question.
 */
function diagnose(rejections: Rejection[]): string[] {
  if (rejections.length === 0) return [];
  return [
    "",
    "Your previous answer was rejected for these units. Fix exactly this:",
    ...rejections
      .filter((rejection) => rejection.unitId !== null)
      .map((rejection) => `- ${rejection.unitId}: ${rejection.code} — ${rejection.detail}`),
  ];
}

/**
 * One chunk, from the request to the units that survived it.
 *
 * The retry keeps what was valid and resends only what was not, with the
 * diagnosis attached. The budget is linear — three attempts, then the
 * stragglers fall back to source — because an engine that retries until it
 * succeeds spends money nobody sees until the bill arrives.
 *
 * Truncation needs no special case: the next attempt asks only for what is
 * still missing, which is a smaller request by construction. That is the
 * split, and it costs no extra code.
 */
export async function translateChunk(input: ChunkInput): Promise<ChunkOutcome> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_ATTEMPTS;
  const translated = new Map<string, string>();

  let pending = input.chunk.units;
  let rejections: Rejection[] = [];
  let attempts = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let lastAnswer: AnswerDiagnosis | undefined;

  while (pending.length > 0 && attempts < maxAttempts) {
    input.signal?.throwIfAborted();
    attempts++;

    const request = {
      units: pending,
      context: input.chunk.context,
      terms: termsForChunk(input.terms, pending),
    };
    const prompt = [buildPayload(request), ...diagnose(rejections)].join("\n");

    const result = await input.backend.call({
      prompt,
      system: buildSystem(request),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    tokensIn += result.tokensIn;
    tokensOut += result.tokensOut;
    lastAnswer = {
      finishReason: result.finishReason,
      reasoningTokens: result.reasoningTokens,
      excerpt: result.text.slice(0, EXCERPT_CHARS),
    };

    const validation = validate(result.text, pending, result.finishReason);
    for (const [unitId, text] of validation.accepted) translated.set(unitId, text);

    rejections = validation.rejections;
    pending = pending.filter((unit) => !translated.has(unit.id));
  }

  const reasonFor = (unitId: string) =>
    rejections.find((rejection) => rejection.unitId === unitId)?.code ?? "exhausted";

  return {
    translated,
    fellBack: pending.map((unit) => ({ unitId: unit.id, reason: reasonFor(unit.id) })),
    attempts,
    tokensIn,
    tokensOut,
    ...(lastAnswer === undefined ? {} : { lastAnswer }),
  };
}

export interface RunSummary {
  units: { total: number; translated: number; fellBack: number; identical: number };
  /** The units nobody translates, by the state that says why. */
  notTranslated: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
}

export interface RunInput {
  units: TranslationUnit[];
  store: ProjectStore;
  backend: LlmBackend;
  progress: ProgressSink;
  cacheKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  bookSummary?: string;
  description?: string;
  concurrency?: number;
  /**
   * The model's context window in tokens, when it is known. It can only
   * shrink the chunks: the default budget is also quality's ceiling.
   */
  contextWindowTokens?: number | null;
  signal?: AbortSignal;
}

/** Runs `worker` over `items`, `limit` at a time, in order. */
async function inParallel<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const running = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await worker(next);
    }
  });
  await Promise.all(running);
}

/**
 * The whole book, one chunk at a time.
 *
 * Every confirmed unit is written before the next chunk starts. That is what
 * makes a pause free: stopping loses nothing, and resuming means working out
 * what is missing rather than remembering where we were.
 */
export async function translateUnits(input: RunInput): Promise<RunSummary> {
  const terms = await input.store.terms();
  const held = await input.store.translations(input.cacheKey);

  // A fallback is not work: it is the source text stored under another name,
  // because three attempts failed. Counting it as done is how a run stops
  // asking — the paragraph stays in the original language for ever, the
  // retry budget meant to rescue it is never spent, and the progress bar
  // reports the failure as if it were a page translated.
  const settled = [...held.values()].filter((stored) => stored.outcome !== "fell-back");
  const done = new Set(settled.map((stored) => stored.unitId));

  const chunks = planChunks({
    units: input.units,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    ...(input.bookSummary === undefined ? {} : { bookSummary: input.bookSummary }),
    ...(input.description === undefined ? {} : { description: input.description }),
    maxCharsPerChunk: charsBudgetFor(input.contextWindowTokens ?? null),
    done,
  });

  const work = input.units.filter((unit) => isWork(unit.state));
  const notTranslated: Record<string, number> = {};
  for (const unit of input.units) {
    if (isWork(unit.state)) continue;
    notTranslated[unit.state] = (notTranslated[unit.state] ?? 0) + 1;
  }

  let translated = settled.length;
  let identical = settled.filter((stored) => stored.outcome === "identical").length;
  let fellBack = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  await inParallel(chunks, input.concurrency ?? 2, async (chunk) => {
    const outcome = await translateChunk({
      chunk, terms, backend: input.backend,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    tokensIn += outcome.tokensIn;
    tokensOut += outcome.tokensOut;

    for (const unit of chunk.units) {
      const text = outcome.translated.get(unit.id);
      if (text === undefined) continue;

      // A translation identical to its source is a success, and it is counted:
      // above a few per cent it is the symptom of a model handing the input
      // back, which nobody notices by reading a page.
      const same = text === unit.source;
      await input.store.putTranslation({
        unitId: unit.id, text, cacheKey: input.cacheKey,
        attempts: outcome.attempts, outcome: same ? "identical" : "translated",
      });
      translated++;
      if (same) identical++;
      input.progress.report({ phase: "translate", done: translated, total: work.length, unitId: unit.id });
    }

    for (const fallen of outcome.fellBack) {
      fellBack++;
      await input.store.putTranslation({
        unitId: fallen.unitId,
        text: chunk.units.find((unit) => unit.id === fallen.unitId)!.source,
        cacheKey: input.cacheKey, attempts: outcome.attempts, outcome: "fell-back",
      });
      // Declared, always. A unit that fell back to its source reads as
      // untranslated prose in the middle of a translated book, and the only
      // thing that separates it from a defect nobody knows about is this line.
      await input.store.event({
        code: "unit-fell-back",
        severity: "degradation",
        payload: {
          unitId: fallen.unitId, reason: fallen.reason, attempts: outcome.attempts,
          ...(outcome.lastAnswer ?? {}),
        },
      });
    }
  });

  return {
    units: { total: input.units.length, translated, fellBack, identical },
    notTranslated: notTranslated as Record<UnitState, number>,
    tokensIn,
    tokensOut,
  };
}
