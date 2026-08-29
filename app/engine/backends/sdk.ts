import { jsonSchema, type LanguageModel } from "ai";
import type { LlmBackend, LlmCall, LlmResult } from "../../../core/ports.ts";
import type { ResolvedModel } from "./resolve.ts";

type GenerateTextInput = Parameters<typeof import("ai").generateText>[0];

/**
 * `generateText` as this adapter needs it, described structurally.
 *
 * The result stays structural so tests can supply the smallest honest fake;
 * the input names the SDK types now that `ai` is a production dependency.
 */
export interface GenerateInput {
  model: LanguageModel;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  providerOptions?: GenerateTextInput["providerOptions"];
}

export interface GenerateOutput {
  text?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    /** Where the SDK keeps the reasoning split, for every provider that reports one. */
    outputTokenDetails?: { reasoningTokens?: number };
  };
  finishReason?: string;
}

export type GenerateFn = (input: GenerateInput) => Promise<GenerateOutput>;

/** `generateObject` as this adapter needs it: a schema in, an object out. */
export interface StructuredInput extends Omit<GenerateInput, "maxOutputTokens"> {
  schema: unknown;
}

export interface StructuredOutput extends Omit<GenerateOutput, "text"> {
  object?: unknown;
}

export type StructuredFn = (input: StructuredInput) => Promise<StructuredOutput>;

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
export function sdkBackend(
  resolved: ResolvedModel,
  generate: GenerateFn,
  /** Absent means this build cannot impose a shape, whatever the model claims. */
  generateStructured?: StructuredFn,
): LlmBackend {
  // Both halves or neither. A backend that announced a shape it has no way to
  // impose would be sent instructions with no format in them, and would answer
  // in prose that nothing can attribute to a unit.
  const structured = resolved.structured === true && generateStructured !== undefined;

  return {
    structured,

    async call(input: LlmCall): Promise<LlmResult> {
      const common = {
        model: resolved.model as LanguageModel,
        prompt: input.prompt,
        system: input.system,
        abortSignal: input.signal,
        providerOptions: resolved.options as GenerateTextInput["providerOptions"],
      };

      const result = structured && input.schema !== undefined
        ? await generateStructured!({ ...common, schema: jsonSchema(input.schema as never) })
        : await generate({ ...common, maxOutputTokens: input.maxOutputTokens });

      return {
        // The object is the answer under one contract and the text under the
        // other; the engine reads one shape, so the object becomes its JSON.
        text: "object" in result
          ? JSON.stringify(result.object ?? {})
          : (result as GenerateOutput).text ?? "",
        tokensIn: count(result.usage?.inputTokens),
        tokensOut: count(result.usage?.outputTokens),
        reasoningTokens: count(result.usage?.outputTokenDetails?.reasoningTokens),
        finishReason: finish(result.finishReason),
      };
    },
  };
}
