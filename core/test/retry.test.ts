import { describe, expect, it, vi } from "vitest";
import { BabelError } from "../errors.ts";
import type { LlmBackend, LogRecord } from "../ports.ts";
import { retryingBackend, type RetryPolicy } from "../translate/retry.ts";

const answer = {
  text: "ok", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
};

/** A backend that throws the given things in order, then answers. */
function flaky(...throws: unknown[]): LlmBackend & { calls: number } {
  let at = 0;
  const backend = {
    calls: 0,
    async call() {
      backend.calls++;
      const next = throws[at++];
      if (next !== undefined) throw next;
      return answer;
    },
  };
  return backend;
}

function harness(inner: LlmBackend, policy?: Partial<RetryPolicy>) {
  const waits: number[] = [];
  const logged: LogRecord[] = [];
  const wrapped = retryingBackend(inner, {
    classify: (error) => error as BabelError,
    log: { record: (entry) => logged.push(entry) },
    sleep: async (ms) => { waits.push(ms); },
    ...(policy === undefined ? {} : { policy }),
  });
  return { wrapped, waits, logged };
}

const transient = () => new BabelError("gone", { code: "PROVIDER_UNREACHABLE", fault: "transient" });

describe("the retrying backend", () => {
  it("answers without waiting when nothing went wrong", async () => {
    const { wrapped, waits } = harness(flaky());
    expect((await wrapped.call({ prompt: "one" })).text).toBe("ok");
    expect(waits).toEqual([]);
  });

  it("retries a transient failure and reports the answer that came", async () => {
    const inner = flaky(transient(), transient());
    const { wrapped, waits } = harness(inner);

    expect((await wrapped.call({ prompt: "one" })).text).toBe("ok");
    expect(inner.calls).toBe(3);
    expect(waits.length).toBe(2);
  });

  /** Exponential, and each wait strictly longer than the one before it. */
  it("backs off exponentially, under the ceiling", async () => {
    const inner = flaky(...Array.from({ length: 4 }, transient));
    const { wrapped, waits } = harness(inner, { baseMs: 1000, maxMs: 4000, maxAttempts: 5 });

    await wrapped.call({ prompt: "one" });
    expect(waits.length).toBe(4);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThan(2000);
    expect(waits[1]).toBeGreaterThanOrEqual(2000);
    for (const wait of waits) expect(wait).toBeLessThanOrEqual(4000);
  });

  /** When the provider named an hour, we do not guess a different one. */
  it("waits exactly as long as the provider asked", async () => {
    const throttled = new BabelError("slow down", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled", retryAfterMs: 7000,
    });
    const { wrapped, waits } = harness(flaky(throttled));

    await wrapped.call({ prompt: "one" });
    expect(waits).toEqual([7000]);
  });

  it("does not let the provider's hour exceed the ceiling", async () => {
    const throttled = new BabelError("slow down", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled", retryAfterMs: 900_000,
    });
    const { wrapped, waits } = harness(flaky(throttled), { maxMs: 60_000 });

    await wrapped.call({ prompt: "one" });
    expect(waits).toEqual([60_000]);
  });

  it("gives up after the budget, and throws the last classified failure", async () => {
    const inner = flaky(...Array.from({ length: 9 }, transient));
    const { wrapped } = harness(inner, { maxAttempts: 5 });

    await expect(wrapped.call({ prompt: "one" })).rejects.toMatchObject({
      code: "PROVIDER_UNREACHABLE", fault: "transient",
    });
    expect(inner.calls).toBe(5);
  });

  it.each([
    ["config", "PROVIDER_UNAUTHORIZED"],
    ["exhausted", "PROVIDER_OUT_OF_CREDIT"],
    ["defect", "PROVIDER_UNKNOWN"],
  ])("does not retry a %s failure", async (fault, code) => {
    const inner = flaky(new BabelError("no", { code, fault: fault as never }));
    const { wrapped, waits } = harness(inner);

    await expect(wrapped.call({ prompt: "one" })).rejects.toMatchObject({ code });
    expect(inner.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  /**
   * A pause must not wait out sixty seconds to be felt. The signal is read
   * before the call and again during the wait.
   */
  it("stops waiting the moment the run is stopped", async () => {
    const stop = new AbortController();
    const inner = flaky(...Array.from({ length: 4 }, transient));
    const wrapped = retryingBackend(inner, {
      classify: (error) => error as BabelError,
      log: { record: () => {} },
      sleep: async (_ms, signal) => {
        stop.abort();
        signal?.throwIfAborted();
      },
    });

    await expect(wrapped.call({ prompt: "one", signal: stop.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(inner.calls).toBe(1);
  });

  it("refuses to start once the run is stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const inner = flaky();
    const { wrapped } = harness(inner);

    await expect(wrapped.call({ prompt: "one", signal: stop.signal })).rejects.toThrow();
    expect(inner.calls).toBe(0);
  });

  /** The line the Registro was missing: that we are retrying, and why. */
  it("says it is retrying, and says when it stopped having to", async () => {
    const { wrapped, logged } = harness(flaky(transient(), transient()));
    await wrapped.call({ prompt: "one" });

    const retries = logged.filter((entry) => entry.code === "provider-retry");
    expect(retries.length).toBe(2);
    expect(retries[0]!.level).toBe("warn");
    expect(retries[0]!.detail).toMatchObject({
      attempt: 1, max: 5, reason: "PROVIDER_UNREACHABLE",
    });
    expect(typeof retries[0]!.detail!["waitMs"]).toBe("number");

    const recovered = logged.filter((entry) => entry.code === "provider-recovered");
    expect(recovered.length).toBe(1);
    expect(recovered[0]!.detail).toMatchObject({ attempts: 3 });
  });

  it("says nothing about recovery when nothing went wrong", async () => {
    const { wrapped, logged } = harness(flaky());
    await wrapped.call({ prompt: "one" });
    expect(logged.filter((entry) => entry.code === "provider-recovered")).toEqual([]);
  });

  /** Not broken, only slow — which is the case nobody could see before. */
  it("says when a call took longer than the slow mark", async () => {
    vi.useFakeTimers();
    try {
      const logged: LogRecord[] = [];
      const wrapped = retryingBackend({
        call: async () => { vi.advanceTimersByTime(45_000); return answer; },
      }, {
        classify: (error) => error as BabelError,
        log: { record: (entry) => logged.push(entry) },
        sleep: async () => {},
      });

      await wrapped.call({ prompt: "one" });
      const slow = logged.find((entry) => entry.code === "provider-slow");
      expect(slow?.level).toBe("info");
      expect(slow?.detail).toMatchObject({ elapsedMs: 45_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The same trap `countingBackend` fell into: a decorator that drops this
   * changes the contract the whole run translates under, invisibly.
   */
  it("keeps the answer's shape imposable", () => {
    const { wrapped } = harness({ call: async () => answer, structured: true });
    expect(wrapped.structured).toBe(true);
  });
});
