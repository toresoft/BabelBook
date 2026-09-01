import { describe, expect, it } from "vitest";
import { APICallError, LoadAPIKeyError, NoSuchModelError, TypeValidationError } from "@ai-sdk/provider";
import { classifyProviderError } from "../engine/backends/classify.ts";

/** An SDK error as a provider really builds one, key and all. */
function apiError(init: {
  statusCode?: number; headers?: Record<string, string>; body?: string; retryable?: boolean;
}): APICallError {
  return new APICallError({
    message: `provider said ${init.statusCode ?? "nothing"}`,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: { headers: { authorization: "Bearer sk-secret-key" } },
    ...(init.statusCode === undefined ? {} : { statusCode: init.statusCode }),
    ...(init.headers === undefined ? {} : { responseHeaders: init.headers }),
    ...(init.body === undefined ? {} : { responseBody: init.body }),
    ...(init.retryable === undefined ? {} : { isRetryable: init.retryable }),
  });
}

describe("classifying what a provider answered", () => {
  it("calls a 429 with a wait a throttling, and honours the wait", () => {
    const classified = classifyProviderError(apiError({
      statusCode: 429, headers: { "retry-after": "7" },
    }));
    expect(classified.code).toBe("PROVIDER_RATE_LIMITED");
    expect(classified.fault).toBe("throttled");
    expect(classified.retryAfterMs).toBe(7000);
  });

  it("reads a retry-after given as a date", () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    const classified = classifyProviderError(apiError({ statusCode: 429, headers: { "retry-after": when } }));
    expect(classified.retryAfterMs).toBeGreaterThan(20_000);
    expect(classified.retryAfterMs).toBeLessThanOrEqual(31_000);
  });

  /**
   * The distinction the whole taxonomy exists for. Both are 429; one is a
   * pause of seconds and the other is a pause until somebody pays.
   */
  it("separates a rate limit from credit that has run out", () => {
    const broke = classifyProviderError(apiError({
      statusCode: 429, body: '{"error":{"message":"You have insufficient credits"}}',
    }));
    expect(broke.code).toBe("PROVIDER_OUT_OF_CREDIT");
    expect(broke.fault).toBe("exhausted");
    expect(broke.retryAfterMs).toBeUndefined();
  });

  it("calls a 402 an exhausted account too", () => {
    expect(classifyProviderError(apiError({ statusCode: 402 })).fault).toBe("exhausted");
  });

  it.each([401, 403])("calls a %i a matter of configuration", (statusCode) => {
    const classified = classifyProviderError(apiError({ statusCode }));
    expect(classified.code).toBe("PROVIDER_UNAUTHORIZED");
    expect(classified.fault).toBe("config");
  });

  it.each([500, 502, 503, 529])("calls a %i transient", (statusCode) => {
    const classified = classifyProviderError(apiError({ statusCode }));
    expect(classified.code).toBe("PROVIDER_SERVER_ERROR");
    expect(classified.fault).toBe("transient");
  });

  it("calls a 404 a model that is not there", () => {
    const classified = classifyProviderError(apiError({ statusCode: 404 }));
    expect(classified.code).toBe("MODEL_NOT_FOUND");
    expect(classified.fault).toBe("config");
  });

  it("calls a request too large for the window a matter of configuration", () => {
    const classified = classifyProviderError(apiError({
      statusCode: 400, body: '{"error":{"message":"maximum context length is 8192 tokens"}}',
    }));
    expect(classified.code).toBe("CONTEXT_EXCEEDED");
    expect(classified.fault).toBe("config");
  });

  it("calls a socket that went away transient", () => {
    const classified = classifyProviderError(
      Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
    );
    expect(classified.code).toBe("PROVIDER_UNREACHABLE");
    expect(classified.fault).toBe("transient");
  });

  it("calls a timeout transient", () => {
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    expect(classifyProviderError(timeout).code).toBe("PROVIDER_TIMEOUT");
    expect(classifyProviderError(timeout).fault).toBe("transient");
  });

  /** An abort is the person's own hand. It must never look like a failure. */
  it("calls an abort a cancellation", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyProviderError(abort).fault).toBe("cancelled");
  });

  it("calls a missing key a matter of configuration", () => {
    const classified = classifyProviderError(new LoadAPIKeyError({ message: "no key" }));
    expect(classified.code).toBe("PROVIDER_UNAUTHORIZED");
    expect(classified.fault).toBe("config");
  });

  it("calls an unknown model a matter of configuration", () => {
    const classified = classifyProviderError(
      new NoSuchModelError({ modelId: "nope", modelType: "languageModel" }),
    );
    expect(classified.code).toBe("MODEL_NOT_FOUND");
  });

  /** The schema contract's own failure: the answer came, and it was not usable. */
  it("calls an answer that did not fit the schema unusable", () => {
    const classified = classifyProviderError(
      new TypeValidationError({ value: { nope: true }, cause: new Error("bad shape") }),
    );
    expect(classified.code).toBe("RESPONSE_UNUSABLE");
    expect(classified.fault).toBe("transient");
  });

  it("calls anything it does not recognise a defect, and keeps the cause", () => {
    const cause = new Error("who knows");
    const classified = classifyProviderError(cause);
    expect(classified.code).toBe("PROVIDER_UNKNOWN");
    expect(classified.fault).toBe("defect");
    expect(classified.cause).toBe(cause);
  });

  /** The rule of the design, asserted at the one place that reads a raw error. */
  it("never lets the key into the detail", () => {
    const classified = classifyProviderError(apiError({ statusCode: 401 }));
    expect(JSON.stringify(classified.detail)).not.toContain("sk-secret-key");
    expect(Object.keys(classified.detail)).toEqual(["status"]);
  });
});
