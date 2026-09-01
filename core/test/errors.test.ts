import { describe, expect, it } from "vitest";
import {
  BabelError, isBabelError, PAUSES_ON, RETRIES_ON, type Fault,
} from "../errors.ts";

const ALL: Fault[] = [
  "transient", "throttled", "exhausted", "config",
  "input", "refused", "defect", "cancelled",
];

describe("the fault taxonomy", () => {
  /**
   * The two tables are the specification. A fault missing from either one
   * would be read as `undefined`, which is falsy, which is to say the run
   * would silently stop retrying and silently choose `failed` — the two
   * decisions this type exists to make.
   */
  it("answers both questions for every fault", () => {
    for (const fault of ALL) {
      expect(typeof RETRIES_ON[fault]).toBe("boolean");
      expect(typeof PAUSES_ON[fault]).toBe("boolean");
    }
    expect(Object.keys(RETRIES_ON).sort()).toEqual([...ALL].sort());
    expect(Object.keys(PAUSES_ON).sort()).toEqual([...ALL].sort());
  });

  it("retries exactly the two faults a retry can help", () => {
    expect(ALL.filter((fault) => RETRIES_ON[fault])).toEqual(["transient", "throttled"]);
  });

  /** `failed` means "resuming would not fix it", and only three faults qualify. */
  it("ends in failed only where resuming would not fix it", () => {
    expect(ALL.filter((fault) => !PAUSES_ON[fault])).toEqual(["input", "refused", "defect"]);
  });
});

describe("a BabelError", () => {
  it("carries its code, its fault and its detail", () => {
    const error = new BabelError("rate limited", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled",
      detail: { status: 429 }, retryAfterMs: 4000,
    });

    expect(error.code).toBe("PROVIDER_RATE_LIMITED");
    expect(error.fault).toBe("throttled");
    expect(error.detail).toEqual({ status: 429 });
    expect(error.retryAfterMs).toBe(4000);
    expect(error.name).toBe("BabelError");
    expect(error).toBeInstanceOf(Error);
  });

  it("keeps the error it was built from, without exposing it", () => {
    const cause = new Error("socket hang up");
    const error = new BabelError("unreachable", {
      code: "PROVIDER_UNREACHABLE", fault: "transient", cause,
    });
    expect(error.cause).toBe(cause);
    expect(error.detail).toEqual({});
  });

  /**
   * Recognised across a process boundary, where `instanceof` cannot be
   * trusted: the engine runs in its own process and the error it throws is
   * structurally cloned, not carried.
   */
  it("is recognised structurally, not by prototype", () => {
    expect(isBabelError(new BabelError("x", { code: "X", fault: "defect" }))).toBe(true);
    expect(isBabelError({ code: "X", fault: "defect", detail: {} })).toBe(true);
    expect(isBabelError({ code: "X", fault: "invented" })).toBe(false);
    expect(isBabelError(new Error("plain"))).toBe(false);
    expect(isBabelError(null)).toBe(false);
  });
});
