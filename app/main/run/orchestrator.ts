import { extractCandidates } from "../../../core/analyze/candidates.ts";
import { indexCodeBlocks } from "../../../core/analyze/code.ts";
import { isWork, type TranslationUnit } from "../../../core/epub/index.ts";
import type { LlmBackend, ProjectStore } from "../../../core/ports.ts";
import { translateUnits } from "../../../core/translate/engine.ts";
import { countingBackend, type Usage } from "../../../core/translate/usage.ts";
import {
  createProjectActor, projectMachine,
} from "../../../core/workflow/project.machine.ts";
import { createActor } from "xstate";
import type { EngineRunner } from "../../engine/main.ts";
import type { EngineMessage, RunConfig, RunSummary } from "../../shared/run.ts";
import { codeIndexKey } from "./code-index-key.ts";

export type { RunConfig, RunSummary } from "../../shared/run.ts";

export interface RunProjectDeps {
  store: ProjectStore;
  backend: LlmBackend;
  config: RunConfig;
  machineSnapshot?: unknown;
  emit(message: EngineMessage): void;
  signal: AbortSignal;
}

function summaryBeforeTranslation(
  units: TranslationUnit[],
  held: Awaited<ReturnType<ProjectStore["translations"]>>,
  spent: Usage,
): RunSummary {
  const notTranslated: Record<string, number> = {};
  for (const unit of units) {
    if (isWork(unit.state)) continue;
    notTranslated[unit.state] = (notTranslated[unit.state] ?? 0) + 1;
  }
  const translations = [...held.values()];
  const fellBack = translations.filter((translation) => translation.outcome === "fell-back");
  return {
    units: {
      total: units.length,
      // A fallback is held in the same table as a translation and is not one:
      // it is the source text, kept so the book can still be composed. The
      // engine will ask for it again, so counting it here would report as
      // finished exactly the work that is still outstanding.
      translated: translations.length - fellBack.length,
      fellBack: fellBack.length,
      identical: translations.filter((translation) => translation.outcome === "identical").length,
    },
    notTranslated,
    tokensIn: spent.tokensIn,
    tokensOut: spent.tokensOut,
    reasoningTokens: spent.reasoningTokens,
  };
}

async function stoppedSummary(store: ProjectStore, config: RunConfig, spent: Usage): Promise<RunSummary> {
  const units = await store.units();
  return summaryBeforeTranslation(units, await store.translations(config.cacheKey), spent);
}

/**
 * Executes model-backed phases in the utility process.
 *
 * This module deliberately depends only on ProjectStore. Snapshot persistence
 * lives in `machine-host.ts`, on the main side of the store/process boundary.
 * The final `compose` phase message hands over to the main process, which owns
 * the composer: this function never claims COMPOSED. It returns the summary,
 * and the summary is the only record of what the run spent — dropping it makes
 * every report say the book cost nothing.
 */
export async function runProject(deps: RunProjectDeps): Promise<RunSummary> {
  const { config, emit, signal, store } = deps;
  signal.throwIfAborted();

  // Mounted once, around the backend every phase already shares. A phase
  // added later has to be remembered to count if this were a parameter on
  // each call; mounted here, it never has to be remembered again. `spent`
  // is what a stopped-at-a-gate summary reports instead of the zeros that
  // used to claim a sampled, paid-for book cost nothing.
  const spent: Usage = { tokensIn: 0, tokensOut: 0, reasoningTokens: 0 };
  const backend = countingBackend(deps.backend, (total) => {
    spent.tokensIn = total.tokensIn;
    spent.tokensOut = total.tokensOut;
    spent.reasoningTokens = total.reasoningTokens;
    emit({ type: "usage", ...total });
  });

  const actor = deps.machineSnapshot === undefined
    ? createProjectActor({
      hasLanguage: true,
      hasApprovedTerms: (await store.terms()).length > 0,
      autoAcceptTerms: config.autoAcceptTerms,
      autoAcceptExclusions: config.autoAcceptExclusions,
    }).start()
    : createActor(projectMachine, { snapshot: deps.machineSnapshot as never }).start();

  if (actor.getSnapshot().value === "ready") actor.send({ type: "START" });
  if (actor.getSnapshot().value === "waiting-terms") {
    emit({ type: "gate", gate: "terms" });
    return stoppedSummary(store, config, spent);
  }
  if (actor.getSnapshot().value === "waiting-code") {
    emit({ type: "gate", gate: "code" });
    return stoppedSummary(store, config, spent);
  }
  if (actor.getSnapshot().value === "composing") {
    emit({ type: "phase", phase: "compose" });
    return stoppedSummary(store, config, spent);
  }
  if (actor.getSnapshot().value !== "running") {
    throw new Error(`RUN_STATE_${String(actor.getSnapshot().value).toUpperCase()}`);
  }

  if (!actor.getSnapshot().context.hasApprovedTerms) {
    emit({ type: "phase", phase: "candidates" });
    let report = await store.candidateReport(config.cacheKey);
    if (report === null) {
      const unitsBeforeTerms = await store.units();
      report = await extractCandidates({
        units: unitsBeforeTerms,
        backend,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        progress: { report: (p) => emit({ type: "progress", phase: p.phase, done: p.done, total: p.total }) },
        signal,
      });
      await store.putCandidateReport(config.cacheKey, report);
    }
    if (config.autoAcceptTerms && report.candidates.length > 0) {
      await store.putTerms(report.candidates.map((candidate) => ({
        source: candidate.source,
        ...(candidate.target === undefined ? {} : { target: candidate.target }),
        rule: candidate.rule,
        origin: candidate.origin,
        ...(candidate.sense === undefined ? {} : { sense: candidate.sense }),
        ...(candidate.note === undefined ? {} : { note: candidate.note }),
      })));
    }
    signal.throwIfAborted();
    actor.send({ type: "TERMS_READY" });
    emit({ type: "transition", event: "TERMS_READY" });
    if (actor.getSnapshot().value === "waiting-terms") {
      emit({ type: "gate", gate: "terms" });
      return stoppedSummary(store, config, spent);
    }
  }

  if (!actor.getSnapshot().context.hasReviewedExclusions) {
    emit({ type: "phase", phase: "code-index" });
    const indexKey = codeIndexKey(config.cacheKey);
    let code = await store.codeIndex(indexKey);
    if (code === null) {
      const unitsBeforeCode = await store.units();
      code = await indexCodeBlocks({
        units: unitsBeforeCode,
        backend,
        sourceHash: indexKey,
        concurrency: config.concurrency,
        progress: { report: (p) => emit({ type: "progress", phase: p.phase, done: p.done, total: p.total }) },
        signal,
      });
      await store.commitCodeIndex(code);
    }
    signal.throwIfAborted();
    actor.send({ type: "CODE_INDEXED" });
    emit({ type: "transition", event: "CODE_INDEXED" });
    if (actor.getSnapshot().value === "waiting-code") {
      emit({ type: "gate", gate: "code" });
      return stoppedSummary(store, config, spent);
    }
  }

  emit({ type: "phase", phase: "translate" });
  const units = await store.units();
  const summary = await translateUnits({
    units,
    store,
    backend,
    cacheKey: config.cacheKey,
    sourceLanguage: config.sourceLanguage,
    targetLanguage: config.targetLanguage,
    concurrency: config.concurrency,
    contextWindowTokens: config.contextWindowTokens ?? null,
    signal,
    progress: {
      report(progress): void {
        emit({ type: "progress", phase: progress.phase, done: progress.done, total: progress.total });
      },
    },
  });

  actor.send({ type: "TRANSLATED" });
  emit({ type: "transition", event: "TRANSLATED" });
  emit({ type: "phase", phase: "compose" });
  // The run's totals, not the translation phase's own: candidates and
  // code-index spent tokens too, and the summary is the only record of what
  // the whole run cost.
  return { ...summary, tokensIn: spent.tokensIn, tokensOut: spent.tokensOut, reasoningTokens: spent.reasoningTokens };
}

/** Narrow production adapter the runtime registers. */
export function makeEngineRunner(deps: { backend: LlmBackend }): EngineRunner {
  return async (input) => {
    const summary = await runProject({
      store: input.store,
      backend: deps.backend,
      config: input.config,
      ...(input.machineSnapshot === undefined ? {} : { machineSnapshot: input.machineSnapshot }),
      emit: input.emit,
      signal: input.signal,
    });

    // The engine's last word, and the only place the token counts exist. It
    // says the engine is finished, not that the book is: composition belongs
    // to the main process, and the reader is told when the file is on disk.
    input.emit({ type: "done", summary });
  };
}
