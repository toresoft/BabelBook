import type { LlmBackend } from "../../../core/ports.ts";

/**
 * What a verification says, and deliberately all it says.
 *
 * There is no `message` field, and that is the point. A provider's own words
 * are English, change without notice, and sometimes quote the key back — an
 * echoed request header, an "invalid api key sk-…". A field that could carry
 * one would eventually carry one, into a log or a bug report.
 */
export interface VerifyResult {
  ok: boolean;
  code?: VerifyCode;
  latencyMs?: number;
  modelId?: string;
}

export type VerifyCode =
  | "missing-key" | "package-missing" | "unsupported-provider" | "unauthorized"
  | "unreachable" | "bad-spec" | "unknown";

export interface VerifyDeps {
  backend: LlmBackend;
  modelId: string;
  /** A check that never answers must still end. */
  timeoutMs?: number;
}

/** Long enough for a cold model to answer, short enough to be a dialog. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** The shortest exchange that still proves the whole path works. */
const PROMPT = "Reply with the single word: ok";
const MAX_OUTPUT_TOKENS = 32;

/** Resolution codes and verification codes are one vocabulary, mapped here. */
const SPEC_CODES: Record<string, VerifyCode> = {
  PACKAGE_MISSING: "package-missing",
  UNSUPPORTED_ROUTE: "unsupported-provider",
  MISSING_KEY: "missing-key",
  MISSING_ROUTE: "bad-spec",
  INVALID_ROUTE: "bad-spec",
  MISSING_ID: "bad-spec",
  FACTORY_MISSING: "package-missing",
  FACTORY_AMBIGUOUS: "package-missing",
  FACTORY_FAILED: "bad-spec",
};

const UNAUTHORIZED = /unauthor|forbidden|invalid[\s_-]*api[\s_-]*key|authentication|credential/i;
const UNREACHABLE =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|CERT_|self[\s-]signed|fetch failed|socket hang up|network/i;

function statusOf(error: unknown): number | null {
  const candidate = error as { statusCode?: unknown; status?: unknown };
  for (const value of [candidate?.statusCode, candidate?.status]) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return null;
}

/**
 * Reduces any failure to one of the codes the interface has words for.
 *
 * Exported because resolution fails before a backend exists: whoever wires the
 * IPC catches a `ModelSpecError` from `resolveModel` and passes it here, so a
 * missing package and a refused key reach the screen in the same vocabulary as
 * a bad round trip, rather than in two.
 *
 * A status the provider stated outranks anything in its message. Reading a
 * number out of prose is how the mention of a code inside an unrelated
 * sentence becomes a diagnosis.
 */
export function classifyError(error: unknown): VerifyCode {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && code in SPEC_CODES) return SPEC_CODES[code]!;

  const name = (error as Error)?.name;
  if (name === "AbortError" || name === "TimeoutError") return "unreachable";
  // Node's system errors put the identifier on `code`, not in the message.
  if (typeof code === "string" && UNREACHABLE.test(code)) return "unreachable";

  const status = statusOf(error);
  if (status === 401 || status === 403) return "unauthorized";
  if (status !== null && status >= 500) return "unreachable";
  if (status !== null) return "unknown";

  const message = typeof (error as Error)?.message === "string" ? (error as Error).message : "";
  if (UNAUTHORIZED.test(message) || /\b(401|403)\b/.test(message)) return "unauthorized";
  if (UNREACHABLE.test(message)) return "unreachable";
  return "unknown";
}

/**
 * One minimal call, timed, reported as an outcome and never as a sentence.
 *
 * The latency is worth as much as the success: an endpoint that answers in
 * eight seconds will translate a book in days, and the user should learn that
 * from the Verify button rather than from a progress bar.
 */
export async function verifyProvider(deps: VerifyDeps): Promise<VerifyResult> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = performance.now();

  try {
    await deps.backend.call({
      prompt: PROMPT,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      signal: timeout,
    });
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      modelId: deps.modelId,
    };
  } catch (error) {
    // A backend that ignores the signal would otherwise be reported by
    // whatever it eventually threw; the expired timeout is the truer answer.
    const code = timeout.aborted ? "unreachable" : classifyError(error);
    return { ok: false, code, latencyMs: Math.round(performance.now() - started), modelId: deps.modelId };
  }
}
