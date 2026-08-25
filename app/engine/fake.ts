import { appendFileSync } from "node:fs";
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
 * resume asked for nothing it already had. Without them the fake is instant
 * and silent, which is what every other consumer wants.
 */
const DELAY_MS = Number(process.env["BABELBOOK_FAKE_DELAY_MS"] ?? "0");
const CALL_LOG = process.env["BABELBOOK_FAKE_LOG"];

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

function verdictAnswer(lines: string[], headerAt: number): Response {
  const ids: string[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (line.trim() === "END") break;
    const verdict = /^\[v:([^\]]+)\]\s*$/.exec(line.trim());
    if (verdict !== null) ids.push(verdict[1]!);
  }
  // Everything is prose: the run has nothing to exclude and no degradation to
  // declare, which is what keeps the expected end state assertable.
  return {
    text: [`VERDICTS ${ids.length}`, ...ids.map((id) => `[v:${id}] prose`), "END"].join("\n"),
    ids,
    kind: "verdicts",
  };
}

function respond(prompt: string): Response {
  const lines = prompt.split(/\r?\n/);

  const verdictsAt = lines.findIndex((line) => /^VERDICTS\s+\d+$/.test(line.trim()));
  if (verdictsAt !== -1) return verdictAnswer(lines, verdictsAt);

  // Term extraction: the instruction block names the format verbatim.
  if (prompt.includes("TERMS <count>")) return { text: "TERMS 0\nEND", ids: [], kind: "terms" };

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
  return {
    async call(input: LlmCall): Promise<LlmResult> {
      const { text, ids, kind } = respond(input.prompt);
      logCall(kind, ids);
      if (DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      return {
        text,
        tokensIn: input.prompt.length,
        tokensOut: text.length,
        finishReason: "stop",
      };
    },
  };
}
