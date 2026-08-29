import { describe, expect, it } from "vitest";
import type { LlmCall, LlmResult } from "../../core/ports.ts";
import { classifyError, verifyProvider } from "../main/providers/verify.ts";
import { ModelSpecError } from "../engine/backends/resolve.ts";

const ok = { call: async () => ({ text: "pong", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const }) };
const failing = (message: string) => ({ call: async (): Promise<LlmResult> => { throw new Error(message); } });

describe("verifyProvider", () => {
  it("reports success with the round trip time", async () => {
    const result = await verifyProvider({ backend: ok, modelId: "acme:m1" });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.modelId).toBe("acme:m1");
  });

  it("maps an authentication failure to a code, not a raw message", async () => {
    const result = await verifyProvider({ backend: failing("401 Unauthorized"), modelId: "acme:m1" });
    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("maps a network failure to unreachable", async () => {
    const result = await verifyProvider({ backend: failing("getaddrinfo ENOTFOUND api.acme.test"), modelId: "acme:m1" });
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
  });

  it("does not leak the provider message to the caller", async () => {
    const result = await verifyProvider({ backend: failing("401 Unauthorized key sk-abc123"), modelId: "acme:m1" });
    expect(JSON.stringify(result)).not.toContain("sk-abc123");
  });

  it("keeps nothing of an unrecognised failure but the fact that it failed", async () => {
    const result = await verifyProvider({ backend: failing("teapot sk-abc123"), modelId: "acme:m1" });
    expect(result).toMatchObject({ ok: false, code: "unknown" });
    expect(JSON.stringify(result)).not.toContain("sk-abc123");
  });

  it("asks for the smallest answer it can, so a check costs almost nothing", async () => {
    const seen: LlmCall[] = [];
    const recording = {
      call: async (input: LlmCall): Promise<LlmResult> => {
        seen.push(input);
        return { text: "ok", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" };
      },
    };
    await verifyProvider({ backend: recording, modelId: "acme:m1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.maxOutputTokens).toBeLessThanOrEqual(32);
    expect(seen[0]!.prompt.length).toBeLessThanOrEqual(64);
  });

  it("gives up rather than hanging the settings screen for ever", async () => {
    const hangs = {
      call: (input: LlmCall): Promise<LlmResult> => new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal!.reason));
      }),
    };
    const result = await verifyProvider({ backend: hangs, modelId: "acme:m1", timeoutMs: 5 });
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
  });
});

describe("classifyError", () => {
  it("carries a resolution failure over to the same vocabulary", () => {
    expect(classifyError(new ModelSpecError("PACKAGE_MISSING", "ghost:m1", "not installed")))
      .toBe("package-missing");
    expect(classifyError(new ModelSpecError("MISSING_KEY", "acme:m1", "no key")))
      .toBe("missing-key");
    expect(classifyError(new ModelSpecError("INVALID_ROUTE", "../evil:m1", "bad")))
      .toBe("bad-spec");
  });

  it("tells a provider this application does not serve from a package left uninstalled", () => {
    const unsupported = new ModelSpecError("UNSUPPORTED_ROUTE", "watsonx:m1", "not served");
    const missing = new ModelSpecError("PACKAGE_MISSING", "openai:gpt-5", "not installed");

    // The two have different remedies: one is an endpoint typed by hand, the
    // other is a build that shipped wrong. One sentence for both would send the
    // user looking for a terminal that is not there.
    expect(classifyError(unsupported)).toBe("unsupported-provider");
    expect(classifyError(missing)).toBe("package-missing");
  });

  it("prefers a status the provider stated over words in its message", () => {
    // The SDK carries the status on the error; a message that merely mentions
    // a number is not a status, and reading it as one is how a book titled
    // "401" turns into an authentication failure.
    expect(classifyError(Object.assign(new Error("something went wrong"), { statusCode: 403 })))
      .toBe("unauthorized");
  });
});
