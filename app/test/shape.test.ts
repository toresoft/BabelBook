import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { translateChunk } from "../../core/translate/engine.ts";
import { negotiatingBackend } from "../../core/translate/negotiate.ts";
import type { LlmCall, LlmResult } from "../../core/ports.ts";
import type { Chunk } from "../../core/translate/plan.ts";
import type { TranslationUnit } from "../../core/epub/index.ts";
import { classifyProviderError } from "../engine/backends/classify.ts";

/**
 * The run this was written for, end to end across the seam.
 *
 * A project on DeepSeek walked through `analyze`, `candidates` and
 * `code-index` — three phases, 468 tokens, all paid — and died on the first
 * chunk of `translate` with a 400. The catalogue said the model could be held
 * to a schema; the endpoint in front of it takes `text` or `json_object` and
 * nothing else, and `translate` is the only phase that sends a schema.
 *
 * Every other test of this fix stops at one side of the boundary: the core
 * ones hand the engine an error already classified, and the classifier's own
 * ones never reach the engine. This is the whole chain — a real `APICallError`
 * with the words DeepSeek actually answers, through the real classifier, into
 * the loop that chooses the contract.
 */
const DEEPSEEK_400 = new APICallError({
  message: "Failed after 3 attempts. Last error: invalid_request_error",
  url: "https://api.deepseek.com/chat/completions",
  // As a provider really builds one: the request travels with the error, and
  // the key travels with the request. Nothing may copy it out.
  requestBodyValues: { headers: { authorization: "Bearer sk-secret-key" } },
  statusCode: 400,
  responseBody: '{"error":{"message":"response_format.type must be one of text, json_object",'
    + '"type":"invalid_request_error"}}',
});

const unit: TranslationUnit = {
  id: "c1.xhtml#1", kind: "block", doc: "c1.xhtml", ordinal: 1,
  range: [0, 3], source: "One", raw: "One", state: "translate",
};

const chunk: Chunk = {
  units: [unit],
  context: {
    sourceLanguage: "en", targetLanguage: "it", before: [], after: [], interleaved: [],
    chapter: { doc: "c1.xhtml", position: 1, total: 1 },
  },
};

/** An endpoint that refuses a schema exactly as DeepSeek's does, and answers otherwise. */
function deepseekLike() {
  const calls: LlmCall[] = [];
  return {
    calls,
    backend: {
      structured: true,
      async call(input: LlmCall): Promise<LlmResult> {
        calls.push(input);
        if (input.schema !== undefined) throw DEEPSEEK_400;
        return {
          text: "UNITS 1\n[u:c1.xhtml#1]\nUno\nEND",
          tokensIn: 10, tokensOut: 3, reasoningTokens: 0, finishReason: "stop" as const,
        };
      },
    },
  };
}

describe("a book on an endpoint that cannot be asked for a shape", () => {
  it("is translated anyway, in words, without spending an attempt on the refusal", async () => {
    const endpoint = deepseekLike();
    const denied: string[] = [];
    const backend = negotiatingBackend(endpoint.backend, {
      classify: classifyProviderError,
      onDowngrade: () => denied.push("structuredOutput"),
    });

    const out = await translateChunk({ chunk, terms: [], backend });

    expect(out.translated.get("c1.xhtml#1")).toBe("Uno");
    expect(out.attempts).toBe(1);
    expect(denied).toEqual(["structuredOutput"]);

    // Two calls: the one that asked for the shape, and the one that asked in
    // words. The second is the whole other contract, not the first with the
    // schema removed — its system prompt is the one that has to argue for a
    // header and a marker per unit.
    expect(endpoint.calls).toHaveLength(2);
    expect(endpoint.calls[0]!.schema).toBeDefined();
    expect(endpoint.calls[1]!.schema).toBeUndefined();
    expect(endpoint.calls[1]!.system).toContain("UNITS");
  });

  /** The chunk after this one must not pay the same call to learn the same thing. */
  it("does not ask for a shape again, once it has been refused", async () => {
    const endpoint = deepseekLike();
    const backend = negotiatingBackend(endpoint.backend, { classify: classifyProviderError });

    await translateChunk({ chunk, terms: [], backend });
    await translateChunk({ chunk, terms: [], backend });

    expect(endpoint.calls).toHaveLength(3);
    expect(endpoint.calls.filter((call) => call.schema !== undefined)).toHaveLength(1);
  });

  /**
   * The rule the classifier is built around, asserted where a real provider
   * error meets it: the response may be kept, the request may not.
   */
  it("keeps the provider's explanation and never the key", () => {
    const classified = classifyProviderError(DEEPSEEK_400);
    expect(classified.code).toBe("PROVIDER_REFUSED_SHAPE");
    expect(String(classified.detail["body"])).toContain("must be one of text, json_object");
    expect(JSON.stringify(classified.detail)).not.toContain("sk-secret-key");
  });
});
