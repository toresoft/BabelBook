/**
 * The shapes that cross the IPC boundary.
 *
 * Plain data, defined here and depending on nothing: the renderer compiles
 * this file, and a type borrowed from the core would drag the EPUB layer — and
 * its Node-only declarations — into the window's compilation. A serialisation
 * boundary should carry its own vocabulary anyway; what the main process
 * happens to use internally is not the contract.
 */

/**
 * The phases a run goes through, in the order it goes through them.
 *
 * It lives here, with the IPC vocabulary, because three parties need it: the
 * engine that emits it, the main process that forwards it, and the window that
 * names it. It mirrors `Progress["phase"]` in `core/ports.ts`, and the
 * orchestrator's `emit` is what holds the two together — a phase added there
 * and not here stops compiling.
 */
export type RunPhase = "analyze" | "candidates" | "code-index" | "translate" | "compose";

export const RUN_PHASES: readonly RunPhase[] = [
  "analyze", "candidates", "code-index", "translate", "compose",
];

export type PhaseState = "done" | "running" | "waiting" | "failed" | "paused";

export interface PhaseProgress {
  phase: RunPhase;
  state: PhaseState;
  /** When it began and when it ended, from the state it recorded. */
  startedAt: string | null;
  endedAt: string | null;
  /** Only the translation counts the book; the others count their own work. */
  done: number | null;
  total: number | null;
  /** What that phase knows about itself: counts, an error code, a path. */
  info: Record<string, unknown> | null;
}

/** One line of the run's log: a state the project lived through, or an event its engine reported. */
export interface LogLine {
  at: string;
  kind: "state" | "event";
  code: string;
  severity: "info" | "warning" | "error";
  /** What that line knows about itself: counts, an error code, a duration. */
  info: Record<string, unknown> | null;
}

export interface CreateProjectRequest {
  epubPath: string;
  targetLanguage: string;
  sourceLanguage?: string;
  description?: string;
  /** Not optional any more: a project without a provider cannot be translated. */
  providerId: string;
  modelId: string;
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
  /** The provider and model this book will be translated with. */
  providerId?: string;
  modelId?: string;
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
  /** The EPUB the last composition wrote, when there is one. */
  outputPath: string | null;
}

/**
 * A project as its own screen shows it.
 *
 * `actions` is the list of events the state machine would accept right now,
 * asked of the machine itself. The buttons read it instead of re-deriving the
 * rule from the state name: a condition rewritten in a template diverges from
 * the machine the day the machine changes, and nothing fails until someone
 * presses a button that does nothing.
 */
export interface ProjectDetail extends ProjectSummary {
  description: string | null;
  hasOverlays: boolean;
  providerId: string | null;
  modelId: string | null;
  /** The provider's and the model's names, as a reader knows them. */
  providerName: string | null;
  modelName: string | null;
  actions: string[];
  tokens: { in: number; out: number; reasoning: number };
  /**
   * What the runs have cost, when every one of them could be priced. Null
   * when any could not: a sum that skipped the unpriced part would name a
   * number the true total is only the floor of.
   */
  cost: number | null;
  /** The last run's own clock: when it started, and when it ended (null while it is still going, or if none has ever run). */
  runStartedAt: string | null;
  runEndedAt: string | null;
  /** The five phases, always in the order a run walks them. */
  phases: PhaseProgress[];
  /** When the project entered `done`, which is not necessarily when its last run ended. */
  finishedAt: string | null;
}

/** One unit, with whatever has been made of it so far. */
export interface UnitRow {
  unitId: string;
  doc: string;
  ordinal: number;
  /** The state that acts: what the user forced, or what was deduced. */
  state: string;
  forced: boolean;
  reason: string | null;
  source: string;
  /** Null when nothing has been translated yet, which is not an empty string. */
  translation: string | null;
  outcome: string | null;
}

export interface UnitQuery {
  state?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface Settings {
  uiLanguage: string;
  autoAcceptTerms: boolean;
  autoAcceptExclusions: boolean;
  concurrency: number;
  epubcheckJar: string | null;
}

/**
 * A term as a glossary holds it.
 *
 * Structurally what the core calls a `TermEntry`, declared here rather than
 * imported so the renderer does not compile the core to know what a glossary
 * looks like. The optional fields are optional and not nullable on purpose:
 * that is what the markdown format round-trips through, and a `target: null`
 * would come back as an empty cell meaning something else.
 */
export interface GlossaryTerm {
  source: string;
  target?: string;
  rule: TermRule;
  sense?: string;
  note?: string;
  origin: "glossary" | "extracted" | "manual";
}

/** A glossary as the application stores it: the core's shape, plus an identity. */
export interface GlossaryView {
  id: string;
  name: string;
  /** Part of the cache key: a glossary that grew is a different question. */
  version: number;
  description: string;
  sourceLanguage: string;
  targetLanguage: string;
  terms: GlossaryTerm[];
}

/** One structural check on the composed book, and what differs if it failed. */
export interface InvariantResult {
  id: string;
  name: string;
  ok: boolean;
  /** Named, because an invariant that only says "failed" costs an investigation. */
  details: string[];
  skipped?: boolean;
}

export interface EpubcheckMessage {
  id: string;
  severity: "fatal" | "error" | "warning" | "usage";
  message: string;
  path?: string;
}

/**
 * How well the terminology was honoured, counted per rule.
 *
 * The rules are not a scale: disregarding a `prefer` can be the right call
 * when grammar pushes back, while disregarding a `must` is a defect. Adding
 * them together produces a number nobody can act on.
 */
export interface Adherence {
  checked: number;
  respected: number;
  byRule: Record<TermRule, { checked: number; respected: number }>;
  violations: Array<{ unitId: string; term: string; rule: TermRule }>;
}

/** One kind of thing that happened during a run, counted. */
export interface ReportLine {
  code: string;
  severity: "info" | "warning" | "degradation";
  count: number;
  samples: unknown[];
}

/**
 * What happened to a book, as codes rather than as sentences.
 *
 * The interface composes the phrases from its catalogue, in the reader's
 * language. It is also what makes a report worth comparing: two books that
 * went wrong the same way produce the same codes.
 */
export interface Report {
  status: "complete" | "incomplete" | "failed";
  units: {
    total: number;
    translated: number;
    fellBack: number;
    identical: number;
    notTranslated: Record<string, number>;
  };
  /** Above five per cent of translations identical to their source. */
  identicalWarning: boolean;
  degradations: ReportLine[];
  /** What is declared and is not a defect. */
  declarations: ReportLine[];
  invariants: InvariantResult[];
  epubcheck: { ran: boolean; reason?: string; introduced: EpubcheckMessage[] };
  layout: { book: string; prePaginated: number };
  overlaysRemoved: { overlays: number; audio: number };
  terms: { active: number; adherence: Adherence | null };
  cost: { tokensIn: number; tokensOut: number; amount: number | null };
  outputPath: string | null;
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
  /** The document these belong to: without it a technical book is one group of twelve hundred. */
  doc: string;
  units: Array<{ unitId: string; ordinal: number; text: string; forced: boolean }>;
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
  /**
   * The first sentence the term appears in.
   *
   * The gate is unanswerable without it: "Rivendell, do not translate" asks
   * the user to recall a book they may not have read. It comes from the stored
   * candidate report, so it is null for a term nobody extracted.
   */
  context: string | null;
  note: string | null;
}

/** What the catalogue says a model can do. Absent means unknown, never "no". */
export interface ModelCapabilities {
  toolCall: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
  attachment: boolean;
}

/**
 * One model an endpoint serves.
 *
 * Prices are per million tokens and may be null: the estimate then shows
 * tokens only. An invented price is worse than no price, because a wrong
 * number is believed and a missing one is asked about. The same rule holds
 * for every other field the catalogue fills in.
 */
/**
 * How hard a model is asked to think, in words every provider can be told in.
 *
 * A switch could say only whether to think, and a model that translates well
 * while thinking can translate badly without it — measured, on a real book,
 * as one unit in three answered in another language. Not every provider has
 * words for a strength; where one has none, anything but `off` leaves it its
 * own default rather than inventing a budget.
 */
export type ReasoningLevel = "off" | "low" | "high" | "max";

export const REASONING_LEVELS: readonly ReasoningLevel[] = ["off", "low", "high", "max"];

export interface ProviderModel {
  id: string;
  displayName: string;
  contextWindow: number | null;
  priceIn: number | null;
  priceOut: number | null;
  capabilities: ModelCapabilities | null;
  /** Null until the user chooses; runtime resolves an unchosen value to off. */
  reasoningLevel: ReasoningLevel | null;
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
  /** Which catalogue entry this provider was built from, when it was. */
  catalogId: string | null;
  /** The catalogue's production date when its metadata was copied. */
  catalogAt: string | null;
  hasKey: boolean;
}

/**
 * A provider as it is proposed: everything but the id, plus the key once.
 *
 * `apiKeyFromEnv` names the environment variable to read the key from, when
 * the environment already holds the one the entry documents: a name, never a
 * value — the window may say which variable to read, and only the main
 * process may read it. A typed `apiKey` wins over the named variable.
 */
export type ProviderInput = Omit<Provider, "id" | "hasKey"> & {
  apiKey?: string | null;
  apiKeyFromEnv?: string | null;
};

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
 * A model runtime on the user's own machine, found by asking it.
 *
 * The models come from the running server, never from the catalogue: a local
 * runtime serves what its owner pulled, and the catalogue cannot know that.
 * `apiKey` carries the documented difference between the two — Ollama wants a
 * key sent and ignores it, LM Studio wants none.
 */
export interface LocalRuntime {
  id: "ollama" | "lmstudio";
  name: string;
  baseUrl: string;
  apiKey: string | null;
  models: string[];
}

/**
 * One entry of the provider catalogue, as the picker may see it.
 *
 * `models` counts what the catalogue knows, not what the endpoint serves:
 * the two meet when the key is pasted. `options` carries the call options
 * this route needs to behave (DeepSeek without thinking), because they are
 * facts about how the application must call the route, not catalogue data.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  /** Null when this application serves no route for the entry's publisher. */
  route: string | null;
  /** The endpoint's base URL, when the catalogue declares one. */
  baseUrl: string | null;
  options: Record<string, unknown>;
  models: number;
  /**
   * The variable the provider's documentation names for its key, when it names
   * one. Shown, never relied on: an application launched from a desktop menu
   * on Linux does not inherit the shell's environment, so a key exported in a
   * shell profile is simply not there.
   */
  envVar: string | null;
}

/** How old the catalogue in use is, said in one line. */
export interface CatalogState {
  /** When the list in use was produced. */
  at: string;
  providers: number;
  models: number;
  /** True when the bundled snapshot is in use rather than an update. */
  bundled: boolean;
  /**
   * When the network last confirmed this list current, or null when it never
   * has. `at` alone reads as stale for a catalogue that is simply unchanged.
   */
  checkedAt: string | null;
}

/**
 * What a verification says, and deliberately all it says.
 *
 * There is no `message` field, and that is the point: the provider's own words
 * are English, change without notice, and sometimes quote the key back.
 */
export type VerifyCode =
  | "missing-key" | "package-missing" | "unsupported-provider" | "unauthorized"
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
