import { createHash } from "node:crypto";
import { CODE_INDEX_VERSION } from "../../../core/translate/versions.ts";

/**
 * The key the code index is kept under: the run's key, plus this pass's own
 * version.
 *
 * `project_phase_result` already keys a checkpoint per phase, so raising the
 * version throws away the index and nothing else — which is the whole point of
 * not putting it in the shared key.
 */
export function codeIndexKey(cacheKey: string, version: number = CODE_INDEX_VERSION): string {
  return createHash("sha256").update(`code-index ${version} ${cacheKey}`).digest("hex");
}
