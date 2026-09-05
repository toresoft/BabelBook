import { describe, expect, it } from "vitest";
import { BabelError } from "../errors.ts";
import type { LlmBackend, LlmCall, LogRecord } from "../ports.ts";
import { negotiatingBackend } from "../translate/negotiate.ts";

const answer = {
  text: "ok", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
};

const refused = () => new BabelError("no shape here", {
  code: "PROVIDER_REFUSED_SHAPE", fault: "config",
});

/** A backend that remembers every call it was handed, and can refuse the first. */
function recording(throwFirst?: unknown): LlmBackend & { seen: LlmCall[] } {
  const seen: LlmCall[] = [];
  return {
    structured: true,
    seen,
    async call(input: LlmCall) {
      seen.push(input);
      if (seen.length === 1 && throwFirst !== undefined) throw throwFirst;
      return answer;
    },
  };
}

function harness(inner: LlmBackend) {
  const logged: LogRecord[] = [];
  const downgrades: number[] = [];
  const wrapped = negotiatingBackend(inner, {
    classify: (error) => error as BabelError,
    log: { record: (entry) => logged.push(entry) },
    onDowngrade: () => { downgrades.push(1); },
  });
  return { wrapped, logged, downgrades };
}

const schema = { type: "object" } as Record<string, unknown>;

describe("the negotiating backend", () => {
  it("says what the backend under it says, while nothing has been refused", async () => {
    const { wrapped } = harness(recording());
    expect(wrapped.structured).toBe(true);
    expect((await wrapped.call({ prompt: "one", schema })).text).toBe("ok");
  });

  /**
   * The whole point: a model that can produce a shape, behind an endpoint that
   * cannot be asked for one. The refusal is not the run's ending — it is the
   * answer to a question, and the answer is no.
   */
  it("gives up the shape when the endpoint refuses it, and says so once", async () => {
    const { wrapped, logged, downgrades } = harness(recording(refused()));

    await expect(wrapped.call({ prompt: "one", schema })).rejects.toThrow(BabelError);

    expect(wrapped.structured).toBe(false);
    expect(downgrades).toHaveLength(1);
    expect(logged.map((entry) => entry.code)).toEqual(["shape-refused"]);
  });

  /**
   * Total, not advisory. Whoever built the request read `structured` before
   * this call and cannot un-read it; a schema that still arrives afterwards is
   * one the endpoint has already refused, and forwarding it would spend a
   * second call proving the same thing.
   */
  it("strips a schema that arrives after the refusal", async () => {
    const inner = recording(refused());
    const { wrapped } = harness(inner);
    await expect(wrapped.call({ prompt: "one", schema })).rejects.toThrow(BabelError);

    await wrapped.call({ prompt: "two", schema });

    expect(inner.seen[0]!.schema).toEqual(schema);
    expect(inner.seen[1]!.schema).toBeUndefined();
  });

  it("refuses only once, however many chunks ask again", async () => {
    const inner: LlmBackend & { calls: number } = {
      structured: true, calls: 0,
      async call() { this.calls++; throw refused(); },
    };
    const { wrapped, downgrades } = harness(inner);

    await expect(wrapped.call({ prompt: "one", schema })).rejects.toThrow(BabelError);
    await expect(wrapped.call({ prompt: "two", schema })).rejects.toThrow(BabelError);

    expect(downgrades).toHaveLength(1);
  });

  /** Everything else is somebody else's verdict, and passes through untouched. */
  it("leaves every other failure alone, and keeps the shape", async () => {
    const other = new BabelError("gone", { code: "PROVIDER_UNREACHABLE", fault: "transient" });
    const { wrapped, downgrades } = harness(recording(other));

    await expect(wrapped.call({ prompt: "one", schema })).rejects.toThrow(other);

    expect(wrapped.structured).toBe(true);
    expect(downgrades).toEqual([]);
  });

  /** A backend that never claimed a shape has nothing to give up. */
  it("stays silent about a backend that imposes nothing", async () => {
    const { wrapped } = harness({ async call() { return answer; } });
    expect(wrapped.structured).toBeUndefined();
  });
});
