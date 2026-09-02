import { appendFileSync } from "node:fs";
import { APICallError } from "@ai-sdk/provider";
import type { LlmBackend, LlmCall, LlmResult } from "../../core/ports.ts";

/**
 * A deterministic backend for the whole-application test.
 *
 * It answers every phase in the wire format of plan 2, reading the prompts
 * instead of pattern-matching on fixtures: what it returns must survive the
 * same validation a real answer survives, or the test would prove nothing
 * about the path it exercises. Translations carry a marker, so a page that
 * reads like prose can never be mistaken for work the model did.
 *
 * It never touches the network, which is the other half of its job: the suite
 * must be able to say "the application works" without saying "and so does the
 * provider's endpoint today".
 */

/** Prepended to every fake translation, and to nothing else. */
export const FAKE_MARKER = "[FAKE]";

/**
 * Test knobs, read here and nowhere else.
 *
 * `BABELBOOK_FAKE_DELAY_MS` paces the calls so a test can pause a run while it
 * is genuinely in flight; `BABELBOOK_FAKE_LOG` names a file that receives one
 * JSON line per call with the ids it was asked for, so a test can prove the
 * resume asked for nothing it already had; `BABELBOOK_FAKE_FAILURES` makes it
 * stumble. Without them the fake is instant, silent and reliable, which is
 * what every other consumer wants.
 */
const DELAY_MS = Number(process.env["BABELBOOK_FAKE_DELAY_MS"] ?? "0");
const CALL_LOG = process.env["BABELBOOK_FAKE_LOG"];

/**
 * How the deterministic backend is told to stumble.
 *
 * `429x2` throws a rate limit on the first two calls and answers after that;
 * `402` alone throws for ever. It exists so the suite can prove the retry
 * without a provider and without a network — which is to say, so it can prove
 * it at all: every other way of producing a 429 depends on somebody else's
 * endpoint having a bad afternoon.
 *
 * The error is a real `APICallError` and not a shortcut, because the thing
 * under test is the classifier that reads one.
 */
interface FailurePlan {
  status: number;
  times: number;
}

function plannedFailures(): FailurePlan | null {
  const plan = process.env["BABELBOOK_FAKE_FAILURES"];
  if (plan === undefined || plan === "") return null;

  const [status, times] = plan.split("x");
  const parsed = Number(status);
  if (!Number.isFinite(parsed)) return null;

  return {
    status: parsed,
    times: times === undefined ? Number.POSITIVE_INFINITY : Number(times),
  };
}

interface Response {
  text: string;
  ids: string[];
  kind: "units" | "verdicts" | "terms" | "sample";
}

function translationAnswer(lines: string[], headerAt: number): Response {
  const out: string[] = [];
  const ids: string[] = [];
  let current: string | null = null;
  const collected: string[] = [];

  const flush = (): void => {
    if (current !== null) out.push(`[u:${current}]`, `${FAKE_MARKER} ${collected.join("\n")}`);
  };

  for (const line of lines.slice(headerAt + 1)) {
    if (line.trim() === "END") break;
    const marker = /^\[u:([^\]]+)\]\s*$/.exec(line.trim());
    if (marker !== null) {
      flush();
      current = marker[1]!;
      ids.push(current);
      collected.length = 0;
      continue;
    }
    if (current !== null) collected.push(line);
  }
  flush();

  const declared = Number(/^UNITS\s+(\d+)$/.exec(lines[headerAt]!.trim())![1]);
  return { text: [`UNITS ${declared}`, ...out, "END"].join("\n"), ids, kind: "units" };
}

/** The code-index question, which carries the batch its answer must name back. */
const CODE_INDEX = /^#CODEINDEX\s+v1\s+batch=(\d+)\/(\d+)\s+count=(\d+)\s*$/;

/**
 * Every line is prose.
 *
 * The run has nothing to exclude and no degradation to declare, which is what
 * keeps the expected end state assertable: a fake that guessed at code would
 * make the exclusions gate of the end-to-end tests depend on its taste rather
 * than on the book in front of it.
 *
 * The verdicts are numbered by position — `[1]`, `[2]` — and the batch and
 * count are echoed from the question, because `parseCodeVerdict` checks all
 * three and reads an answer that disagrees as no answer at all.
 */
function verdictAnswer(header: RegExpExecArray): Response {
  const count = Number(header[3]);
  const ids = Array.from({ length: count }, (_, at) => String(at + 1));
  return {
    text: [
      `#CODEVERDICT v1 batch=${header[1]}/${header[2]} count=${count}`,
      ...ids.map((id) => `[${id}] translate`),
      "@end",
    ].join("\n"),
    ids,
    kind: "verdicts",
  };
}

/**
 * Proposes terms the passage actually contains.
 *
 * Answering `TERMS 0` was simpler and made the gate a screen that never asked
 * anything: every test walked past an empty list and proved nothing about it.
 * Inventing words instead would be worse — extraction discards a proposal the
 * book does not contain, so the gate would still be empty and the reason would
 * be hidden one layer deeper.
 */
function termAnswer(prompt: string): Response {
  const passage = prompt.split("---")[1] ?? "";
  const found = [...new Set(passage.match(/\b[A-Z][a-z]{2,}\b/g) ?? [])].slice(0, 2);
  if (found.length === 0) return { text: "TERMS 0\nEND", ids: [], kind: "terms" };

  return {
    text: [
      `TERMS ${found.length}`,
      `[t:${found[0]}] rule=dnt note=a name`,
      ...(found[1] === undefined ? [] : [`[t:${found[1]}] rule=prefer target=${found[1]}-reso`]),
      "END",
    ].join("\n"),
    ids: found,
    kind: "terms",
  };
}

function respond(prompt: string): Response {
  const lines = prompt.split(/\r?\n/);

  // Matched on the question's own header and never on `#CODEVERDICT`: the
  // prompt spells the answer's format out verbatim, so looking for the reply
  // would find the instructions describing it.
  for (const line of lines) {
    const asked = CODE_INDEX.exec(line.trim());
    if (asked !== null) return verdictAnswer(asked);
  }

  // Term extraction: the instruction block names the format verbatim.
  if (prompt.includes("TERMS <count>")) return termAnswer(prompt);

  const unitsAt = lines.findIndex((line) => /^UNITS\s+\d+$/.test(line.trim()));
  if (unitsAt !== -1) return translationAnswer(lines, unitsAt);

  // Sampled prose for the book summary: a single line is all the caller keeps.
  return { text: "A book being translated for a test.", ids: [], kind: "sample" };
}

function logCall(kind: "units" | "verdicts" | "terms" | "sample", ids: string[]): void {
  if (CALL_LOG === undefined) return;
  appendFileSync(CALL_LOG, `${JSON.stringify({ kind, ids })}\n`);
}

export function fakeBackend(): LlmBackend {
  const plan = plannedFailures();
  let failed = 0;

  return {
    async call(input: LlmCall): Promise<LlmResult> {
      // Before anything else, and before the call log: a call that threw was
      // made and answered nothing, and counting it as work would make the
      // resume test's arithmetic quietly wrong.
      if (plan !== null && failed < plan.times) {
        failed++;
        throw new APICallError({
          message: `fake provider answered ${plan.status}`,
          url: "https://fake.invalid/v1/messages",
          requestBodyValues: {},
          statusCode: plan.status,
          // Short on purpose: the backoff honours it, and a test must not wait
          // out a real provider's idea of a polite pause.
          responseHeaders: { "retry-after": "1" },
          ...(plan.status === 402
            ? { responseBody: '{"error":{"message":"insufficient credits"}}' }
            : {}),
        });
      }

      const { text, ids, kind } = respond(input.prompt);
      logCall(kind, ids);
      if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      return {
        text,
        tokensIn: input.prompt.length,
        tokensOut: text.length,
        reasoningTokens: 0,
        finishReason: "stop",
      };
    },
  };
}
