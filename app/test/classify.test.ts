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

  /**
   * The failure this taxonomy was missing, and the one that cost a run.
   *
   * A model can produce structured output and the endpoint in front of it can
   * still have no way to ask for one: DeepSeek's API takes `text` or
   * `json_object` and nothing else. The 400 that comes back is not a defect
   * and not a fact about the book — it is the two sides disagreeing about the
   * contract, and the engine has a second contract to fall back on.
   */
  it("recognises an endpoint that cannot be asked to impose a shape", () => {
    const classified = classifyProviderError(apiError({
      statusCode: 400,
      body: '{"error":{"message":"response_format.type must be one of text, json_object"}}',
    }));
    expect(classified.code).toBe("PROVIDER_REFUSED_SHAPE");
    expect(classified.fault).toBe("config");
  });

  it("recognises it from the word the other providers use for the same thing", () => {
    const classified = classifyProviderError(apiError({
      statusCode: 400, body: '{"error":{"message":"json_schema is not supported by this model"}}',
    }));
    expect(classified.code).toBe("PROVIDER_REFUSED_SHAPE");
  });

  /**
   * Every other 400 is still a refusal of the request as written, and the
   * remedy is still in the settings rather than in this code. It was a
   * `defect` before, which sent the reader to look for a bug in the
   * application for something only they could fix.
   */
  it("calls any other 400 a matter of configuration, not a defect", () => {
    const classified = classifyProviderError(apiError({
      statusCode: 400, body: '{"error":{"message":"temperature must be <= 2"}}',
    }));
    expect(classified.code).toBe("PROVIDER_REFUSED_REQUEST");
    expect(classified.fault).toBe("config");
  });

  /**
   * The provider's own sentence is the whole answer to a 400, and it used to
   * be thrown away — leaving a file kept for understanding failed runs unable
   * to say anything about the one failure that explains itself.
   *
   * The response is safe in the way the request is not: the key travels in the
   * request, which is why nothing here is ever copied wholesale.
   */
  it("keeps the provider's words for a 400, and still not the key", () => {
    const classified = classifyProviderError(apiError({
      statusCode: 400, body: '{"error":{"message":"response_format.type must be one of text, json_object"}}',
    }));
    expect(String(classified.detail["body"])).toContain("must be one of text, json_object");
    expect(JSON.stringify(classified.detail)).not.toContain("sk-secret-key");
  });

  it("truncates a body long enough to be a transcript", () => {
    const classified = classifyProviderError(apiError({
      statusCode: 400, body: `{"error":"${"x".repeat(4000)}"}`,
    }));
    expect(String(classified.detail["body"]).length).toBeLessThanOrEqual(520);
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
