/**
 * The shapes that cross the IPC boundary.
 *
 * Plain data, defined here and depending on nothing: the renderer compiles
 * this file, and a type borrowed from the core would drag the EPUB layer — and
 * its Node-only declarations — into the window's compilation. A serialisation
 * boundary should carry its own vocabulary anyway; what the main process
 * happens to use internally is not the contract.
 */

export interface CreateProjectRequest {
  epubPath: string;
  targetLanguage: string;
  sourceLanguage?: string;
  description?: string;
  providerId?: string;
  modelId?: string;
}

export type LayoutKind = "reflowable" | "pre-paginated" | "mixed";

export interface LayoutSummary {
  book: LayoutKind;
  prePaginated: number;
  documents: number;
}

export interface CreatedProject {
  id: string;
  title: string;
  author?: string;
  coverPath: string | null;
  declaredLanguage: string | null;
  documents: number;
  units: { total: number; work: number; byState: Record<string, number> };
  words: number;
  layout: LayoutSummary;
  hasOverlays: boolean;
}

export interface UpdateProjectRequest {
  id: string;
  targetLanguage?: string;
  sourceLanguage?: string | null;
  description?: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  author?: string;
  coverPath: string | null;
  sourceLanguage: string | null;
  targetLanguage: string;
  state: string;
  progress: { done: number; total: number };
  layout: LayoutKind;
  createdAt: string;
}

export interface Settings {
  uiLanguage: string;
  autoAcceptTerms: boolean;
  autoAcceptExclusions: boolean;
  concurrency: number;
  epubcheckJar: string | null;
}

/** A state that means "this will not be translated", and why. */
export type ExcludedState =
  | "code" | "translate-no" | "never-translated" | "uncomposable" | "maybe-code";

/**
 * One reason a set of units is being left alone.
 *
 * Grouped because that is how it is read: "forty blocks excluded by the
 * stylesheet" is one question, not forty. `forced` says the user has already
 * ruled on that unit, so a freed block stays visible with somewhere to undo it.
 */
export interface ExclusionGroup {
  state: ExcludedState | "translate";
  reason: string | null;
  units: Array<{ unitId: string; text: string; forced: boolean }>;
}

/** What a change in terminology would undo, priced in tokens, before it undoes it. */
export interface InvalidationPreview {
  units: string[];
  /** Null when nothing is affected: no work, so no cost. */
  cost: { tokensIn: number; tokensOut: number } | null;
}

/**
 * How strongly a term binds.
 *
 * Three, not two. Measured on the prototype's own glossaries: 73 `dnt`, 55
 * `prefer`, 1 `must`. A preferred rendering is not an obligatory one, and
 * folding it into `must` would strengthen fifty-five rules their author
 * deliberately left weak.
 */
export type TermRule = "dnt" | "prefer" | "must";

/**
 * A term as the approval gate shows it.
 *
 * `occurrences` is what makes the gate answerable: a word appearing twice and
 * a word appearing four hundred times deserve different amounts of the user's
 * attention, and a list without the count asks them to guess.
 */
export interface TermRow {
  id: string;
  source: string;
  target: string | null;
  rule: TermRule;
  origin: "glossary" | "extracted" | "manual";
  approval: "pending" | "approved" | "rejected";
  occurrences: number;
  /** Which meaning of the word this entry is about; null when it has only one. */
  sense: string | null;
  note: string | null;
}

/**
 * One model an endpoint serves.
 *
 * Prices are per million tokens and may be null: the estimate then shows
 * tokens only. An invented price is worse than no price, because a wrong
 * number is believed and a missing one is asked about.
 */
export interface ProviderModel {
  id: string;
  displayName: string;
  contextWindow: number | null;
  priceIn: number | null;
  priceOut: number | null;
}

/**
 * An LLM endpoint as the renderer is allowed to see it.
 *
 * `hasKey` is the whole of what is said about the credential. The bytes are
 * absent from the type, so no serialisation of it — an IPC reply, a devtools
 * panel, a crash dump — can carry them by accident. That is a property of the
 * shape rather than of anyone remembering to strip a field.
 */
export interface Provider {
  id: string;
  name: string;
  /** The `@ai-sdk/*` package that serves it. */
  route: string;
  baseUrl: string | null;
  headers: Record<string, string>;
  /** Call options the route requires, keyed by provider as the SDK expects. */
  options: Record<string, unknown>;
  models: ProviderModel[];
  hasKey: boolean;
}

/** A provider as it is proposed: everything but the id, plus the key once. */
export type ProviderInput = Omit<Provider, "id" | "hasKey"> & { apiKey?: string | null };

/**
 * A partial edit.
 *
 * An absent `apiKey` means "do not touch it", never "clear it": the renderer
 * cannot send back a key it is not allowed to see, so any other reading would
 * wipe the credential every time a name or a model list is edited. Clearing is
 * `null`, and has to be said on purpose.
 */
export type ProviderPatch = Partial<Omit<Provider, "id" | "hasKey">> & { apiKey?: string | null };

/** A starting value for a known endpoint. Editable afterwards, never a cage. */
export type ProviderPreset = Omit<Provider, "id" | "hasKey">;

/**
 * What a verification says, and deliberately all it says.
 *
 * There is no `message` field, and that is the point: the provider's own words
 * are English, change without notice, and sometimes quote the key back.
 */
export type VerifyCode =
  | "missing-key" | "package-missing" | "unauthorized"
  | "unreachable" | "bad-spec" | "unknown";

export interface VerifyOutcome {
  ok: boolean;
  code?: VerifyCode;
  latencyMs?: number;
  modelId?: string;
}

/**
 * A failure, as it crosses the IPC boundary.
 *
 * Electron serialises a rejected invocation down to its message: a custom
 * class and its fields do not survive. Everything this application knows how to
 * say about a failure is a code plus its details, so both are packed into the
 * message and unpacked on the other side. Without that, "this is a MOBI"
 * arrives as a sentence nobody can translate or branch on.
 */
export interface IpcFailure {
  code: string;
  [detail: string]: unknown;
}

const MARKER = "babelbook-failure:";

export function packFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: unknown };
  const code = typeof failure.code === "string" ? failure.code : "UNKNOWN";

  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error as object)) {
    if (key !== "code" && key !== "stack" && (typeof value === "string" || typeof value === "number")) {
      details[key] = value;
    }
  }

  return MARKER + JSON.stringify({
    code,
    message: typeof failure.message === "string" ? failure.message : String(error),
    ...details,
  });
}

export function unpackFailure(error: unknown): IpcFailure {
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return { code: "UNKNOWN" };

  const at = message.indexOf(MARKER);
  if (at === -1) return { code: "UNKNOWN", message };

  try {
    return JSON.parse(message.slice(at + MARKER.length)) as IpcFailure;
  } catch {
    return { code: "UNKNOWN", message };
  }
}
