/*
 * Shared because both sides need the same number.
 *
 * The window estimates a book before it is started; the main process
 * estimates what re-translating a handful of units would cost before it
 * invalidates them. Two copies of these constants would drift, and the two
 * screens would quote different prices for the same work.
 */

export interface Estimate {
  tokensIn: number;
  tokensOut: number;
  /** Null when the model declares no prices. */
  cost: number | null;
}

export interface EstimateInput {
  words: number;
  /**
   * How many times the average word is paid for on the way in.
   *
   * A unit is sent once as work and again as context for its neighbours, and
   * the instructions and terminology ride along with every chunk. 1.5 is a
   * prudent round number, not a measurement.
   */
  contextOverhead?: number;
  /** Per million tokens. */
  priceIn: number | null;
  priceOut: number | null;
}

/** English prose, roughly. Named because it is an assumption, not a constant of nature. */
const TOKENS_PER_WORD = 1.4;
const DEFAULT_CONTEXT_OVERHEAD = 1.5;
const PER_MILLION = 1_000_000;

/**
 * What a number of tokens costs, at prices quoted per million.
 *
 * The one place that turns tokens into money. The estimate calls it before a
 * book is started and the run calls it after one is finished, and they have to
 * agree: two copies of this arithmetic would part company the day a provider
 * quotes per thousand, or the day cached tokens get their own rate.
 *
 * Null when either price is unknown, because half a price is not a price.
 */
export function priceTokens(input: {
  tokensIn: number; tokensOut: number; priceIn: number | null; priceOut: number | null;
}): number | null {
  if (input.priceIn === null || input.priceOut === null) return null;
  return (input.tokensIn / PER_MILLION) * input.priceIn
    + (input.tokensOut / PER_MILLION) * input.priceOut;
}

/**
 * What a book will cost, to an order of magnitude.
 *
 * It is an estimate and the interface says so. Its job is to stop someone
 * starting a 250,000-word novel on an expensive model without knowing — not to
 * predict an invoice.
 *
 * With no prices declared, only the tokens come back. Showing an invented
 * figure would be worse than showing none: a number on a screen is believed.
 */
export function estimate(input: EstimateInput): Estimate {
  const overhead = input.contextOverhead ?? DEFAULT_CONTEXT_OVERHEAD;
  const tokensIn = Math.round(input.words * TOKENS_PER_WORD * overhead);
  const tokensOut = Math.round(input.words * TOKENS_PER_WORD);

  return {
    tokensIn,
    tokensOut,
    cost: priceTokens({ tokensIn, tokensOut, priceIn: input.priceIn, priceOut: input.priceOut }),
  };
}
