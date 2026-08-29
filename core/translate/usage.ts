import type { LlmBackend } from "../ports.ts";

/** What a run has spent so far, in the three numbers a provider reports. */
export interface Usage {
  tokensIn: number;
  tokensOut: number;
  /** The share of `tokensOut` spent thinking rather than answering. */
  reasoningTokens: number;
}

/**
 * A backend that keeps the bill.
 *
 * A decorator rather than a parameter on each phase, because a phase added
 * later has to be remembered to count and this does not have to be remembered
 * at all: it is mounted once, around the backend every phase already shares.
 * Before it existed, only the translation counted, and a run that stopped at a
 * gate recorded a cost of zero having paid for everything that got it there.
 */
export function countingBackend(inner: LlmBackend, onUsage: (total: Usage) => void): LlmBackend {
  const total: Usage = { tokensIn: 0, tokensOut: 0, reasoningTokens: 0 };
  return {
    async call(input) {
      const result = await inner.call(input);
      total.tokensIn += result.tokensIn;
      total.tokensOut += result.tokensOut;
      total.reasoningTokens += result.reasoningTokens;
      onUsage({ ...total });
      return result;
    },
  };
}
