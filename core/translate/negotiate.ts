import type { BabelError } from "../errors.ts";
import { nullSink, type LlmBackend, type LlmCall, type LlmResult, type LogSink } from "../ports.ts";

/**
 * The one refusal that is a question's answer rather than a run's ending.
 *
 * A model that can produce structured output and an endpoint that can be
 * asked for it are two different facts, and the catalogue only ever knows the
 * first. When the second turns out to be false the engine is not stuck: it has
 * carried a second contract all along, the one that asks for the shape in
 * words, and that contract is what the rest of the run uses.
 */
export const SHAPE_REFUSED = "PROVIDER_REFUSED_SHAPE";

export interface NegotiateDeps {
  /**
   * Whatever was thrown, as one of ours.
   *
   * Injected for the same reason `retryingBackend` injects it: the core does
   * not know what a 400 is, and if it did it would stop being the core.
   */
  classify(error: unknown): BabelError;
  log?: LogSink;
  /**
   * Told once, when the shape is given up for good.
   *
   * The host is what can remember it past this run — the capability belongs to
   * a row in a database this process cannot reach — so the fact is handed
   * over rather than stored here.
   */
  onDowngrade?: () => void;
}

/**
 * A backend that stops claiming a shape the endpoint will not impose.
 *
 * **It belongs outermost.** `structured` is a getter here and a copied value
 * in the decorators below it: a layer wrapped around this one would freeze the
 * answer at the moment it was built, and whoever reads `backend.structured` to
 * choose a contract would go on choosing the refused one for the whole run.
 *
 * It does not retry. Re-asking is not its business, because the request that
 * would be re-asked is not the same request: the two contracts differ in the
 * prompt as well as in the schema, and only the caller that builds prompts can
 * make the second one. So the refusal is recorded, the shape is dropped, and
 * the error is rethrown for that caller to act on.
 */
export function negotiatingBackend(inner: LlmBackend, deps: NegotiateDeps): LlmBackend {
  const log = deps.log ?? nullSink;
  let structured = inner.structured;
  let told = false;

  return {
    get structured(): boolean | undefined {
      return structured;
    },

    async call(input: LlmCall): Promise<LlmResult> {
      // Total, not advisory. Whoever built this request read `structured`
      // before the refusal and cannot un-read it; forwarding the schema anyway
      // would spend a call proving what is already known.
      const asked = structured === true ? input : { ...input, schema: undefined };

      try {
        return await inner.call(asked);
      } catch (error) {
        if (structured !== true || deps.classify(error).code !== SHAPE_REFUSED) throw error;

        structured = false;
        if (!told) {
          told = true;
          log.record({ level: "warn", code: "shape-refused" });
          deps.onDowngrade?.();
        }
        throw error;
      }
    },
  };
}
