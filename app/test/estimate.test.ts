import { describe, expect, it } from "vitest";
import { estimate, priceTokens } from "../shared/estimate.ts";

describe("estimate", () => {
  it("says how many tokens, and no price when the model declares none", () => {
    const measured = estimate({ words: 100_000, priceIn: null, priceOut: null });

    expect(measured.tokensIn).toBeGreaterThan(100_000);
    expect(measured.tokensOut).toBeGreaterThan(100_000);
    expect(measured.cost).toBeNull();
  });

  it("shows no price when only one of the two is declared", () => {
    expect(estimate({ words: 1000, priceIn: 3, priceOut: null }).cost).toBeNull();
    expect(estimate({ words: 1000, priceIn: null, priceOut: 15 }).cost).toBeNull();
  });

  it("counts the context window as tokens paid more than once", () => {
    const withContext = estimate({ words: 100_000, contextOverhead: 1.5, priceIn: 1, priceOut: 1 });
    const without = estimate({ words: 100_000, contextOverhead: 1, priceIn: 1, priceOut: 1 });

    expect(withContext.tokensIn).toBeGreaterThan(without.tokensIn);
    expect(withContext.tokensOut).toBe(without.tokensOut);
  });

  it("charges input and output at their own prices", () => {
    const cheapOut = estimate({ words: 1_000_000, priceIn: 10, priceOut: 1 });
    const dearOut = estimate({ words: 1_000_000, priceIn: 1, priceOut: 10 });

    expect(cheapOut.cost).toBeGreaterThan(0);
    expect(cheapOut.cost).not.toBe(dearOut.cost);
  });

  it("grows with the book", () => {
    const short = estimate({ words: 10_000, priceIn: 3, priceOut: 15 });
    const long = estimate({ words: 250_000, priceIn: 3, priceOut: 15 });

    expect(long.cost!).toBeGreaterThan(short.cost! * 20);
  });

  it("answers zero for a book with no words rather than a stray fraction", () => {
    expect(estimate({ words: 0, priceIn: 3, priceOut: 15 }))
      .toEqual({ tokensIn: 0, tokensOut: 0, cost: 0 });
  });
});

describe("priceTokens", () => {
  it("prices tokens at rates quoted per million", () => {
    expect(priceTokens({ tokensIn: 1_000_000, tokensOut: 0, priceIn: 3, priceOut: 15 })).toBe(3);
    expect(priceTokens({ tokensIn: 0, tokensOut: 500_000, priceIn: 3, priceOut: 15 })).toBe(7.5);
  });

  it("says nothing when either half of the price is unknown", () => {
    // Half a price is not a price: a figure computed from one side would be
    // wrong in the direction that flatters us.
    expect(priceTokens({ tokensIn: 1000, tokensOut: 1000, priceIn: 3, priceOut: null })).toBeNull();
    expect(priceTokens({ tokensIn: 1000, tokensOut: 1000, priceIn: null, priceOut: 15 })).toBeNull();
  });

  // Production break: the estimate and the run bill the same tokens differently.
  it("gives the estimate and the finished run the same answer for the same tokens", () => {
    const quoted = estimate({ words: 10_000, priceIn: 3, priceOut: 15 });
    const charged = priceTokens({
      tokensIn: quoted.tokensIn, tokensOut: quoted.tokensOut, priceIn: 3, priceOut: 15,
    });

    expect(charged).toBe(quoted.cost);
  });
});
