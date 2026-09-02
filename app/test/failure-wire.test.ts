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

  /**
   * Nine error classes in this application carried a `code` long before any of
   * them carried a `fault`. Reading the code only off a classified error threw
   * every one of them away and answered `UNKNOWN` — which is how a screen that
   * used to name a MOBI started saying the bridge was down.
   */
  it("keeps a code the thrower chose, even unclassified", () => {
    const legacy = Object.assign(new Error("UNSUPPORTED_FORMAT: MOBI"), {
      code: "UNSUPPORTED_FORMAT", format: "MOBI",
    });
    const failure = unpackFailure(overTheBridge(legacy));

    expect(failure.code).toBe("UNSUPPORTED_FORMAT");
    // The fault is a judgement, and only a classifier gets to make one.
    expect(failure.fault).toBe("defect");
    // Its own properties still do not cross: an error nobody classified may be
    // holding the request that caused it, and with it a key. That is what
    // `BabelError.detail` is for, and why the classes were migrated to it.
    expect(failure["format"]).toBeUndefined();
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

    // The same error with nobody to name its fields: the raw error's own
    // surface is not read either, so its key does not cross by accident.
    expect(packFailure(Object.assign(new Error("401"), { apiKey: "sk-secret-key" }))).not.toContain("sk-secret-key");
  });
});
