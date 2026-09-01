import { assign, createActor, setup } from "xstate";

/**
 * What is lawful for a project, and nothing about how any of it is done.
 *
 * The machine is declarative on purpose: it invokes nothing, spawns nothing,
 * calls nothing. It is the Workflow component of Symfony rather than a job
 * runner — it says which transitions exist and which guards let them through,
 * and the orchestrator performs the phase and then reports back with an event.
 *
 * That seam is what makes "nobody spends without being asked" enforceable. A
 * machine that invoked its own phases would start spending from inside a
 * decision, and there would be no moment left at which to refuse.
 *
 * It lives in `core/` because it is domain: it imports no Electron, no
 * database, and its tests run with the rest of the core.
 */

export type ProjectState =
  | "new" | "needs-language" | "ready" | "running"
  | "waiting-terms" | "waiting-code" | "composing"
  | "paused" | "done" | "incomplete" | "failed";

/**
 * Everything the guards read, and no more.
 *
 * These are facts the host already knows — rows it has, hashes it computed,
 * settings the user chose. None of them is derived here, because a machine
 * that computed its own facts would need to read something, and it reads
 * nothing.
 */
export interface ProjectContext {
  /** Whether the pair of languages is settled. Until it is, nothing may start. */
  hasLanguage: boolean;
  hasApprovedTerms: boolean;
  hasReviewedExclusions: boolean;
  /** Whether the workspace copy still hashes to what the units describe. */
  sourceHashMatches: boolean;
  /** How many degradations the run declared. Above zero the book is incomplete. */
  degradations: number;
  autoAcceptTerms: boolean;
  autoAcceptExclusions: boolean;
}

export type ProjectEvent =
  | { type: "LANGUAGE_SET" } | { type: "START" }
  | { type: "TERMS_READY" } | { type: "TERMS_APPROVED" }
  | { type: "CODE_INDEXED" } | { type: "CODE_REVIEWED" }
  | { type: "TRANSLATED" } | { type: "COMPOSED" } | { type: "COMPOSE" }
  | { type: "PAUSE" } | { type: "RESUME" }
  | { type: "FAIL"; reason: string };

/**
 * A project nobody has told anything yet.
 *
 * `sourceHashMatches` starts true because a project is created from a file
 * that was just hashed; it turns false only when a later check says so.
 */
export const INITIAL_CONTEXT: ProjectContext = {
  hasLanguage: false,
  hasApprovedTerms: false,
  hasReviewedExclusions: false,
  sourceHashMatches: true,
  degradations: 0,
  autoAcceptTerms: false,
  autoAcceptExclusions: false,
};

/** What a host may state about a project it is creating. */
export type ProjectInput = Partial<ProjectContext>;

export const projectMachine = setup({
  /**
   * `input` is deliberately left out of the declared types.
   *
   * XState declares it as an optional property, so a type of
   * `ProjectInput | undefined` has the `undefined` inferred away, and
   * `createActor` then demands an `input` even when it is handed a snapshot —
   * which is exactly how a project is restored, and the shape with no input to
   * give. Leaving it undeclared keeps the option optional; `createProjectActor`
   * below restores the type safety at the one place a host needs it.
   */
  types: {
    context: {} as ProjectContext,
    events: {} as ProjectEvent,
  },
  guards: {
    hasLanguage: ({ context }) => context.hasLanguage,
    sourceMatches: ({ context }) => context.sourceHashMatches,
    autoAcceptTerms: ({ context }) => context.autoAcceptTerms,
    autoAcceptExclusions: ({ context }) => context.autoAcceptExclusions,
    termsApproved: ({ context }) => context.hasApprovedTerms,
    exclusionsReviewed: ({ context }) => context.hasReviewedExclusions,
    degraded: ({ context }) => context.degradations > 0,
  },
  actions: {
    noteLanguage: assign({ hasLanguage: true }),
    approveTerms: assign({ hasApprovedTerms: true }),
    reviewExclusions: assign({ hasReviewedExclusions: true }),
  },
}).createMachine({
  id: "project",
  initial: "new",
  context: ({ input }) => ({ ...INITIAL_CONTEXT, ...((input ?? {}) as ProjectInput) }),
  states: {
    /**
     * Transient: a freshly created project is either short a language or
     * ready, and which of the two is a fact rather than a decision.
     */
    new: {
      always: [
        { target: "ready", guard: "hasLanguage" },
        { target: "needs-language" },
      ],
    },

    "needs-language": {
      on: { LANGUAGE_SET: { target: "ready", actions: "noteLanguage" } },
    },

    /**
     * `START` is guarded by the hash and not merely by the button.
     *
     * If the workspace copy changed, the stored unit ranges no longer describe
     * it, and translating anyway composes the wrong book from ranges that have
     * moved. Refusing here costs a re-analysis; not refusing costs a run.
     */
    ready: {
      on: {
        LANGUAGE_SET: { actions: "noteLanguage" },
        START: { target: "running", guard: "sourceMatches" },
        FAIL: "failed",
      },
    },

    /**
     * A gate with auto-acceptance is an internal transition, not a stop: the
     * flag is recorded and the run never leaves `running`. That is the whole
     * difference between the two settings, expressed once.
     */
    running: {
      on: {
        TERMS_READY: [
          { guard: "autoAcceptTerms", actions: "approveTerms" },
          { target: "waiting-terms" },
        ],
        CODE_INDEXED: [
          { guard: "autoAcceptExclusions", actions: "reviewExclusions" },
          { target: "waiting-code" },
        ],
        TRANSLATED: "composing",
        PAUSE: "paused",
        FAIL: "failed",
      },
    },

    /**
     * `RESUME` is guarded rather than absent.
     *
     * A project waiting at a gate looks paused from the library, and the
     * obvious button to press is Resume. The guard is what makes pressing it
     * say "the gate is still open" instead of quietly translating past a
     * decision the user has not made.
     */
    "waiting-terms": {
      on: {
        TERMS_APPROVED: { target: "running", actions: "approveTerms" },
        RESUME: { target: "running", guard: "termsApproved" },
        PAUSE: "paused",
        FAIL: "failed",
      },
    },

    "waiting-code": {
      on: {
        CODE_REVIEWED: { target: "running", actions: "reviewExclusions" },
        RESUME: { target: "running", guard: "exclusionsReviewed" },
        PAUSE: "paused",
        FAIL: "failed",
      },
    },

    /**
     * A run that declared a degradation ends `incomplete`, never `done`.
     *
     * The book is written either way — that is what makes the distinction
     * worth keeping. `done` is a claim, and a run that dropped media overlays
     * or fell back on a unit has not earned it.
     */
    composing: {
      on: {
        COMPOSED: [
          { target: "incomplete", guard: "degraded" },
          { target: "done" },
        ],
        PAUSE: "paused",
        FAIL: "failed",
      },
    },

    /**
     * Resuming re-checks the hash, because a pause is exactly the window in
     * which the file on disk has time to change.
     */
    paused: {
      on: {
        RESUME: { target: "running", guard: "sourceMatches" },
        FAIL: "failed",
      },
    },

    /**
     * Terminal, but deliberately not `final`: a final root state stops the
     * actor, and the interface keeps asking a stopped snapshot what it can do.
     *
     * `COMPOSE` is the retry that room was left for. The translations are the
     * expensive half and they survive an ending; the book is a function of
     * them and of the composer, and a composer is code that changes. Composing
     * again asks no model anything, so an ending is not a sentence: it is the
     * last verdict, and a verdict can be asked for again.
     */
    done: { on: { COMPOSE: "composing" } },
    incomplete: { on: { COMPOSE: "composing" } },

    /**
     * The one ending that is also an interruption, so it offers both retries.
     *
     * A run reaches `failed` two ways that look alike here and are not: the
     * composer refused or threw, with every unit already translated — and the
     * translation itself stopped, on a provider that answered 529 or a network
     * that went away, with the book half done. `COMPOSE` answers the first.
     * For the second it builds a book that is mostly the original, while the
     * units already paid for sit in the store under the key the next run would
     * look them up by, unreachable.
     *
     * So `RESUME` is offered as well, under the same guard a pause carries and
     * for the same reason: a stopped run is exactly the window in which the
     * file on disk has time to change. When nothing was left to translate the
     * resumed run finds it so and walks on to composing, which is the other
     * retry arriving by a longer road.
     */
    failed: {
      on: {
        RESUME: { target: "running", guard: "sourceMatches" },
        COMPOSE: "composing",
      },
    },
  },
});

/**
 * A fresh actor for a project that has just been created.
 *
 * Restoring an existing one needs no helper and no input:
 * `createActor(projectMachine, { snapshot })` with what
 * `getPersistedSnapshot()` wrote to `project.machine_snapshot`.
 */
export function createProjectActor(input: ProjectInput = {}) {
  return createActor(projectMachine, { input });
}
