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

function translationAnswer(lines: string[], headerAt: number): string {
  const out: string[] = [];
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
      collected.length = 0;
      continue;
    }
    if (current !== null) collected.push(line);
  }
  flush();

  const declared = Number(/^UNITS\s+(\d+)$/.exec(lines[headerAt]!.trim())![1]);
  return [`UNITS ${declared}`, ...out, "END"].join("\n");
}

function verdictAnswer(lines: string[], headerAt: number): string {
  const ids: string[] = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (line.trim() === "END") break;
    const verdict = /^\[v:([^\]]+)\]\s*$/.exec(line.trim());
    if (verdict !== null) ids.push(verdict[1]!);
  }
  // Everything is prose: the run has nothing to exclude and no degradation to
  // declare, which is what keeps the expected end state assertable.
  return [`VERDICTS ${ids.length}`, ...ids.map((id) => `[v:${id}] prose`), "END"].join("\n");
}

function answer(prompt: string): string {
  const lines = prompt.split(/\r?\n/);

  const verdictsAt = lines.findIndex((line) => /^VERDICTS\s+\d+$/.test(line.trim()));
  if (verdictsAt !== -1) return verdictAnswer(lines, verdictsAt);

  // Term extraction: the instruction block names the format verbatim.
  if (prompt.includes("TERMS <count>")) return "TERMS 0\nEND";

  const unitsAt = lines.findIndex((line) => /^UNITS\s+\d+$/.test(line.trim()));
  if (unitsAt !== -1) return translationAnswer(lines, unitsAt);

  // Sampled prose for the book summary: a single line is all the caller keeps.
  return "A book being translated for a test.";
}

export function fakeBackend(): LlmBackend {
  return {
    async call(input: LlmCall): Promise<LlmResult> {
      const text = answer(input.prompt);
      return {
        text,
        tokensIn: input.prompt.length,
        tokensOut: text.length,
        finishReason: "stop",
      };
    },
  };
}
