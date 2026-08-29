import { describe, expect, it } from "vitest";
import { countingBackend } from "../translate/usage.ts";
import type { Usage } from "../translate/usage.ts";

function backend(reasoning: number) {
  return {
    call: async () => ({
      text: "ok", tokensIn: 10, tokensOut: 4, reasoningTokens: reasoning, finishReason: "stop" as const,
    }),
  };
}

/**
 * A running total, never a delta.
 *
 * The number crosses a process boundary on its way to a row in the database.
 * A delta that is dropped there is lost for ever and the bill quietly
 * understates itself; a total that is dropped is corrected by the next one.
 */
describe("the counting backend", () => {
  it("hands out the running total after every call", async () => {
    const seen: Usage[] = [];
    const counted = countingBackend(backend(2), (total) => seen.push(total));

    await counted.call({ prompt: "one" });
    await counted.call({ prompt: "two" });

    expect(seen).toEqual([
      { tokensIn: 10, tokensOut: 4, reasoningTokens: 2 },
      { tokensIn: 20, tokensOut: 8, reasoningTokens: 4 },
    ]);
  });

  it("passes the answer through untouched", async () => {
    const counted = countingBackend(backend(0), () => {});
    expect((await counted.call({ prompt: "one" })).text).toBe("ok");
  });

  /**
   * A call that throws was still made and may still have been billed, but
   * nothing came back to count. Reporting a total unchanged is the honest
   * answer; inventing one would be worse than the silence it replaces.
   */
  it("does not report when the call throws", async () => {
    const seen: Usage[] = [];
    const counted = countingBackend(
      { call: async () => { throw new Error("nope"); } },
      (total) => seen.push(total),
    );

    await expect(counted.call({ prompt: "one" })).rejects.toThrow("nope");
    expect(seen).toEqual([]);
  });
});
