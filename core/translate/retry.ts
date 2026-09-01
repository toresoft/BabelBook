import { RETRIES_ON, type BabelError } from "../errors.ts";
import { nullSink, type LlmBackend, type LlmCall, type LlmResult, type LogSink } from "../ports.ts";

/**
 * How many times a call that never produced an answer may be asked again.
 *
 * This is not the engine's retry and does not multiply with it. The engine's
 * three attempts count answers *rejected by validation*; these count calls
 * that produced no answer at all. `sdk.ts` forbids a retry hidden under the
 * engine because it would multiply with that budget invisibly — here the
 * product is stated: 3 × 5 = 15 calls per chunk, worst case, and a number that
 * can be said in advance is the thing that prohibition protected.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseMs: 1_000,
  maxMs: 60_000,
};

/** Above this, a call is worth mentioning even though nothing went wrong. */
export const SLOW_CALL_MS = 30_000;

export interface RetryDeps {
  /**
   * Whatever was thrown, as one of ours.
   *
   * Injected because the core does not know what a 429 is, and if it did it
   * would stop being the core. The engine passes `classifyProviderError`.
   */
  classify(error: unknown): BabelError;
  log?: LogSink;
  /** Injected so the tests do not actually wait five minutes. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  policy?: Partial<RetryPolicy>;
}

/** Exponential, with jitter so a hundred chunks do not all come back at once. */
function backoffFor(attempt: number, policy: RetryPolicy): number {
  const flat = Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs);
  return Math.min(policy.maxMs, Math.round(flat * (1 + Math.random() * 0.5)));
}

/**
 * A backend that asks again when nothing came back.
 *
 * A decorator rather than a parameter on each phase, and for the same reason
 * `countingBackend` is one: mounted once around the backend every phase
 * shares, it does not have to be remembered again. Before it existed, a single
 * 429 halfway through a book ended the whole run — `sdkBackend` does no retry
 * by design, and the engine's own attempts only ever counted answers it had
 * received and rejected.
 */
export function retryingBackend(inner: LlmBackend, deps: RetryDeps): LlmBackend {
  const policy: RetryPolicy = { ...DEFAULT_POLICY, ...deps.policy };
  const log = deps.log ?? nullSink;

  return {
    // Forwarded for the same reason `countingBackend` must forward it: this is
    // mounted around the backend the whole run shares.
    ...(inner.structured === undefined ? {} : { structured: inner.structured }),

    async call(input: LlmCall): Promise<LlmResult> {
      let attempt = 0;

      for (;;) {
        input.signal?.throwIfAborted();
        attempt++;

        const began = Date.now();
        try {
          const result = await inner.call(input);

          const elapsedMs = Date.now() - began;
          if (elapsedMs >= SLOW_CALL_MS) {
            log.record({ level: "info", code: "provider-slow", detail: { elapsedMs } });
          }
          // Said once, and only when there was something to recover from:
          // otherwise the story of a retry is left hanging on the last "we
          // are trying again", which reads like it never came back.
          if (attempt > 1) {
            log.record({ level: "info", code: "provider-recovered", detail: { attempts: attempt } });
          }
          return result;
        } catch (error) {
          const classified = deps.classify(error);

          // A cancellation is the person's own hand and is never retried: it
          // travels this `catch` only because a pause and a failure share it.
          if (classified.fault === "cancelled") throw error;
          if (!RETRIES_ON[classified.fault] || attempt >= policy.maxAttempts) throw classified;

          const waitMs = classified.retryAfterMs === undefined
            ? backoffFor(attempt, policy)
            // Honoured rather than guessed at, but never beyond the ceiling: a
            // provider that answers "come back in an hour" must not hold a run
            // open for an hour.
            : Math.min(classified.retryAfterMs, policy.maxMs);

          log.record({
            level: "warn",
            code: "provider-retry",
            detail: {
              attempt, max: policy.maxAttempts, waitMs, reason: classified.code,
              fault: classified.fault,
            },
          });

          await deps.sleep(waitMs, input.signal);
        }
      }
    },
  };
}
