import type { LlmBackend, LlmCall, LlmResult } from "../../../core/ports.ts";
import type { ResolvedModel } from "./resolve.ts";

/**
 * `generateText` as this adapter needs it, described structurally.
 *
 * The `ai` package is the user's to install and is imported dynamically, so
 * nothing here may name its types: a structural shape the real function
 * satisfies keeps the adapter compilable on a machine where nothing is
 * installed yet, which is every machine before the first provider is added.
 */
export interface GenerateInput {
  model: unknown;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

export interface GenerateOutput {
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
}

export type GenerateFn = (input: GenerateInput) => Promise<GenerateOutput>;

/**
 * A count the provider omitted is zero, never NaN.
 *
 * These are summed into a run's totals and into its cost; one NaN turns the
 * whole report into "NaN tokens", and the arithmetic gives no clue which call
 * it came from.
 */
function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The SDK's finish reasons, narrowed to the three the engine acts on.
 *
 * `length` is kept faithfully because it is the only reason that authorises
 * splitting a chunk: mapping it in with the rest would leave the engine
 * retrying an oversized group unchanged until it gave up. Everything else —
 * a content filter, a tool call, an unknown — is `other`, because the engine
 * treats them identically and inventing a distinction it does not act on
 * would only be a lie with more words.
 */
function finish(reason: string | undefined): LlmResult["finishReason"] {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  return "other";
}

/**
 * `LlmBackend` over the AI SDK.
 *
 * This is the only place the core's port meets a real provider, and it is
 * deliberately thin: no retry, no splitting, no fallback. The engine of plan 2
 * owns all of that, and a second layer of retries hidden here would multiply
 * with it and spend a run's budget several times over.
 */
export function sdkBackend(resolved: ResolvedModel, generate: GenerateFn): LlmBackend {
  return {
    async call(input: LlmCall): Promise<LlmResult> {
      const result = await generate({
        model: resolved.model,
        prompt: input.prompt,
        system: input.system,
        maxOutputTokens: input.maxOutputTokens,
        abortSignal: input.signal,
        providerOptions: resolved.options,
      });

      return {
        text: result.text ?? "",
        tokensIn: count(result.usage?.inputTokens),
        tokensOut: count(result.usage?.outputTokens),
        finishReason: finish(result.finishReason),
      };
    },
  };
}
