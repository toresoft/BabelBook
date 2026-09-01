import type { TranslocoService } from "@jsverse/transloco";
import type { IpcFailure } from "../../../../shared/dto.js";

/**
 * A failure as a reader can use it.
 *
 * The title is deliberately not here. Every screen already has one that is
 * right for itself — `alerts.failed`, `providers.findFailed` — and replacing
 * them with one generic sentence would be a loss dressed as consistency. What
 * was missing is the rest: what happened, what to do, and the identifier to
 * quote when reporting it.
 */
export interface Told {
  body: string;
  hint: string | null;
  code: string;
}

const FAULTS = new Set([
  "transient", "throttled", "exhausted", "config",
  "input", "refused", "defect", "cancelled",
]);

/** Transloco answers with the key itself when it has no entry for it. */
function sentence(transloco: TranslocoService, key: string): string | null {
  const found = transloco.translate(key);
  return found === key || found === "" ? null : found;
}

function failureOf(value: unknown): IpcFailure {
  if (typeof value !== "object" || value === null) return { code: "UNKNOWN", fault: "defect" };
  const candidate = value as { code?: unknown; fault?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : "UNKNOWN",
    fault: typeof candidate.fault === "string" && FAULTS.has(candidate.fault)
      ? (candidate.fault as IpcFailure["fault"])
      : "defect",
  };
}

/**
 * Two lookups, and the second is the reason the fault exists.
 *
 * The specific code first, because it says the most. The class second, because
 * it always says something: a code nobody catalogued used to be printed bare
 * in the middle of an Italian paragraph, and the class turns that hole into a
 * floor. It is what makes the taxonomy useful for the failures nobody
 * anticipated — which are the ones that matter.
 */
export function tell(transloco: TranslocoService, value: unknown): Told {
  const failure = failureOf(value);

  return {
    body: sentence(transloco, `codes.${failure.code}`)
      ?? sentence(transloco, `faults.${failure.fault}.body`)
      ?? sentence(transloco, "faults.defect.body")
      ?? "",
    hint: sentence(transloco, `faults.${failure.fault}.hint`),
    code: failure.code,
  };
}
