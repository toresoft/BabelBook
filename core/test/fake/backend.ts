import type { LlmBackend, LlmCall, LlmResult } from "../../ports.ts";

export type Reply = (call: LlmCall) => LlmResult;

/**
 * A backend that answers what it was told to answer, and no more.
 *
 * Running out of scripted answers is an error, not an empty reply: a fake that
 * answers for ever hides a retry loop that has stopped terminating, which is
 * exactly the failure the engine's tests exist to catch.
 */
export class FakeBackend implements LlmBackend {
  readonly prompts: string[] = [];

  #scripted: string[] | null;
  #reply: Reply | null;

  constructor(answers: string[] | Reply) {
    this.#scripted = Array.isArray(answers) ? [...answers] : null;
    this.#reply = Array.isArray(answers) ? null : answers;
  }

  async call(input: LlmCall): Promise<LlmResult> {
    input.signal?.throwIfAborted();
    this.prompts.push(input.prompt);

    if (this.#reply !== null) return this.#reply(input);

    const next = this.#scripted!.shift();
    if (next === undefined) {
      throw new Error(`FakeBackend: no scripted answer left (call ${this.prompts.length})`);
    }
    return { text: next, tokensIn: 0, tokensOut: 0, reasoningTokens: 0, finishReason: "stop" };
  }
}
