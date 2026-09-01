import { describe, expect, it } from "vitest";
import { BabelError } from "../../core/errors.ts";
import { packFailure, unpackFailure } from "../shared/dto.ts";

/** What `ipcMain.handle` does to a rejection, so the test crosses the same bridge. */
const overTheBridge = (error: unknown): Error => new Error(packFailure(error));

describe("a failure crossing the bridge", () => {
  it("carries the code and the fault", () => {
    const failure = unpackFailure(overTheBridge(new BabelError("rate limited", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled",
      detail: { status: 429 }, retryAfterMs: 4000,
    })));

    expect(failure.code).toBe("PROVIDER_RATE_LIMITED");
    expect(failure.fault).toBe("throttled");
    expect(failure.retryAfterMs).toBe(4000);
    expect(failure["status"]).toBe(429);
  });

  /**
   * An error nobody classified is a defect, not an unknown: the window can
   * still say something true about it, and the diagnostic file has the rest.
   */
  it("calls an unclassified error a defect", () => {
    const failure = unpackFailure(overTheBridge(new Error("something broke")));
    expect(failure.code).toBe("UNKNOWN");
    expect(failure.fault).toBe("defect");
  });

  it("survives a message that is not one of ours", () => {
    expect(unpackFailure(new Error("plain")).fault).toBe("defect");
    expect(unpackFailure(null).fault).toBe("defect");
  });

  /**
   * The rule of the whole design, asserted where it would break: a provider's
   * error object holds the request that caused it. Nothing that is not named
   * gets to cross.
   */
  it("never carries a key, whatever the error was holding", () => {
    const leaky = Object.assign(new Error("401 from provider"), {
      apiKey: "sk-secret-key",
      requestBodyValues: { headers: { authorization: "Bearer sk-secret-key" } },
    });

    const packed = packFailure(new BabelError("unauthorized", {
      code: "PROVIDER_UNAUTHORIZED", fault: "config", detail: { status: 401 }, cause: leaky,
    }));

    expect(packed).not.toContain("sk-secret-key");
  });
});
