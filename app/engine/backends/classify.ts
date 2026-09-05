import {
  APICallError, LoadAPIKeyError, NoSuchModelError, TypeValidationError,
} from "@ai-sdk/provider";
import { BabelError } from "../../../core/errors.ts";

/**
 * The one module that reads what a provider actually threw.
 *
 * It lives here and not in the core for the same reason the SDK does: the core
 * does not know what a 429 is, and if it did it would stop being the core.
 *
 * Everything it returns is built field by field. An SDK error holds the
 * request that caused it — `requestBodyValues`, and with it the headers, and
 * with them the API key. Copying one wholesale is how the promise that the key
 * never leaves this process breaks silently, so nothing is copied: the fields
 * below are named, and the rest is dropped.
 */

/** Phrases providers use for the one 429 that waiting will not fix. */
const OUT_OF_CREDIT = /insufficient (credit|quota|balance)|out of credit|billing|payment required/i;
const CONTEXT_TOO_LONG = /context length|context window|too many tokens|maximum.*tokens|prompt is too long/i;
/**
 * How an endpoint says it cannot be asked to impose a shape.
 *
 * A model that can produce structured output and an endpoint that can be
 * asked for it are two different facts, and the catalogue only knows the
 * first: DeepSeek's API takes `text` or `json_object` and refuses the
 * `json_schema` the SDK sends for a schema. The words vary by provider, the
 * two names in them do not.
 */
const SHAPE_REFUSED = /response_format|json_schema|structured output/i;
/** Long enough for a provider's sentence, short enough not to be a transcript. */
const BODY_KEPT = 500;
const UNREACHABLE = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET",
]);

/** `Retry-After` is seconds or an HTTP date; both become milliseconds, or nothing. */
function retryAfterOf(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw === undefined) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

function nameOf(error: unknown): string {
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function systemCodeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const cause = (error as { cause?: unknown }).cause;
  const nested = (cause as { code?: unknown } | undefined)?.code;
  return typeof nested === "string" ? nested : "";
}

function apiCallError(error: APICallError): BabelError {
  const status = error.statusCode;
  const body = typeof error.responseBody === "string" ? error.responseBody : "";
  const detail: Record<string, string | number | boolean> =
    status === undefined ? {} : { status };

  if (status === 402 || (status === 429 && OUT_OF_CREDIT.test(body))) {
    return new BabelError("the account has nothing left to spend", {
      code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted", detail, cause: error,
    });
  }

  if (status === 429) {
    const retryAfterMs = retryAfterOf(error.responseHeaders);
    return new BabelError("the provider asked us to slow down", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled", detail,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      cause: error,
    });
  }

  if (status === 401 || status === 403) {
    return new BabelError("the provider did not accept the key", {
      code: "PROVIDER_UNAUTHORIZED", fault: "config", detail, cause: error,
    });
  }

  if (status === 404) {
    return new BabelError("the provider does not know that model", {
      code: "MODEL_NOT_FOUND", fault: "config", detail, cause: error,
    });
  }

  if (CONTEXT_TOO_LONG.test(body) || CONTEXT_TOO_LONG.test(error.message)) {
    return new BabelError("the request did not fit the model's window", {
      code: "CONTEXT_EXCEEDED", fault: "config", detail, cause: error,
    });
  }

  // `isRetryable` is the SDK's own verdict and it is worth honouring where we
  // have nothing better: a provider it knows says so about statuses we do not
  // enumerate.
  if ((status !== undefined && status >= 500) || error.isRetryable) {
    return new BabelError("the provider answered with an error of its own", {
      code: "PROVIDER_SERVER_ERROR", fault: "transient", detail, cause: error,
    });
  }

  // A 400 is the provider saying the request itself is wrong, which is never
  // a defect in this application and never something a retry mends: it is the
  // two sides disagreeing about what may be sent, and only the settings — or
  // the contract the engine chose — can settle it.
  //
  // The body comes along, truncated. It is the whole answer to a 400 and it
  // used to be dropped, which left the diagnostics file unable to say anything
  // about the one failure that explains itself. Safe where the request is not:
  // the key travels in the request, and nothing here is copied wholesale.
  if (status === 400) {
    const kept = body === "" ? detail : { ...detail, body: body.slice(0, BODY_KEPT) };
    if (SHAPE_REFUSED.test(body) || SHAPE_REFUSED.test(error.message)) {
      return new BabelError("this endpoint cannot be asked to impose a shape", {
        code: "PROVIDER_REFUSED_SHAPE", fault: "config", detail: kept, cause: error,
      });
    }
    return new BabelError("the provider refused the request as written", {
      code: "PROVIDER_REFUSED_REQUEST", fault: "config", detail: kept, cause: error,
    });
  }

  return new BabelError("the provider refused the request", {
    code: "PROVIDER_UNKNOWN", fault: "defect", detail, cause: error,
  });
}

export function classifyProviderError(error: unknown): BabelError {
  // Already ours: a classifier that reclassified would turn a considered
  // verdict into a guess.
  if (error instanceof BabelError) return error;

  const name = nameOf(error);
  if (name === "AbortError" || name === "TimeoutError") {
    return name === "AbortError"
      ? new BabelError("the run was stopped", { code: "CANCELLED", fault: "cancelled", cause: error })
      : new BabelError("the provider did not answer in time", {
        code: "PROVIDER_TIMEOUT", fault: "transient", cause: error,
      });
  }

  if (APICallError.isInstance(error)) return apiCallError(error);

  if (LoadAPIKeyError.isInstance(error)) {
    return new BabelError("no key was configured for this provider", {
      code: "PROVIDER_UNAUTHORIZED", fault: "config", cause: error,
    });
  }

  if (NoSuchModelError.isInstance(error)) {
    return new BabelError("the provider does not know that model", {
      code: "MODEL_NOT_FOUND", fault: "config", cause: error,
    });
  }

  // The schema contract's own failure: something came back, and it was not
  // usable. Transient because the next sample may well be, and the engine's
  // own attempts are what will find out.
  if (TypeValidationError.isInstance(error)) {
    return new BabelError("the answer did not fit the schema", {
      code: "RESPONSE_UNUSABLE", fault: "transient", cause: error,
    });
  }

  const systemCode = systemCodeOf(error);
  if (UNREACHABLE.has(systemCode)) {
    return new BabelError("the provider could not be reached", {
      code: "PROVIDER_UNREACHABLE", fault: "transient", detail: { errno: systemCode }, cause: error,
    });
  }

  return new BabelError("the provider failed in a way nobody has named", {
    code: "PROVIDER_UNKNOWN", fault: "defect", cause: error,
  });
}
