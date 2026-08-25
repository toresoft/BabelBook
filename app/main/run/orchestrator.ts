import { extractCandidates } from "../../../core/analyze/candidates.ts";
import { indexCodeBlocks } from "../../../core/analyze/code.ts";
import { isWork, type TranslationUnit } from "../../../core/epub/index.ts";
import type { LlmBackend, ProjectStore } from "../../../core/ports.ts";
import { translateUnits } from "../../../core/translate/engine.ts";
import {
  createProjectActor, projectMachine,
} from "../../../core/workflow/project.machine.ts";
import { createActor } from "xstate";
import type { EngineRunner } from "../../engine/main.ts";
import type { EngineMessage, RunConfig, RunSummary } from "../../shared/run.ts";

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
): RunSummary {
  const notTranslated: Record<string, number> = {};
  for (const unit of units) {
    if (isWork(unit.state)) continue;
    notTranslated[unit.state] = (notTranslated[unit.state] ?? 0) + 1;
  }
  const translations = [...held.values()];
  return {
    units: {
      total: units.length,
      translated: translations.length,
      fellBack: translations.filter((translation) => translation.outcome === "fell-back").length,
      identical: translations.filter((translation) => translation.outcome === "identical").length,
    },
    notTranslated,
    tokensIn: 0,
    tokensOut: 0,
  };
}

async function stoppedSummary(store: ProjectStore, config: RunConfig): Promise<RunSummary> {
  const units = await store.units();
  return summaryBeforeTranslation(units, await store.translations(config.cacheKey));
}

/**
 * Executes model-backed phases in the utility process.
 *
 * This module deliberately depends only on ProjectStore. Snapshot persistence
 * lives in `machine-host.ts`, on the main side of Task 5's store/process
 * boundary. The final `compose` phase message is the Task 7 handoff: until a
 * composer is wired, this function does not claim COMPOSED or emit `done`.
 */
export async function runProject(deps: RunProjectDeps): Promise<RunSummary> {
  const { backend, config, emit, signal, store } = deps;
  signal.throwIfAborted();

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
    return stoppedSummary(store, config);
  }
  if (actor.getSnapshot().value === "waiting-code") {
    emit({ type: "gate", gate: "code" });
    return stoppedSummary(store, config);
  }
  if (actor.getSnapshot().value === "composing") {
    emit({ type: "phase", phase: "compose" });
    return stoppedSummary(store, config);
  }
  if (actor.getSnapshot().value !== "running") {
    throw new Error(`RUN_STATE_${String(actor.getSnapshot().value).toUpperCase()}`);
  }

  if (!actor.getSnapshot().context.hasApprovedTerms) {
    emit({ type: "phase", phase: "candidates" });
    const unitsBeforeTerms = await store.units();
    const report = await extractCandidates({
      units: unitsBeforeTerms,
      backend,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage,
      signal,
    });
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
      return stoppedSummary(store, config);
    }
  }

  if (!actor.getSnapshot().context.hasReviewedExclusions) {
    emit({ type: "phase", phase: "code-index" });
    const unitsBeforeCode = await store.units();
    const code = await indexCodeBlocks({
      units: unitsBeforeCode,
      backend,
      sourceHash: config.cacheKey,
      signal,
    });
    for (const unitId of code.marked) {
      await store.putUnitState(unitId, "maybe-code", "model-code-suspected");
    }
    for (const unitId of code.freed) {
      await store.putUnitState(unitId, "translate");
    }
    signal.throwIfAborted();
    actor.send({ type: "CODE_INDEXED" });
    emit({ type: "transition", event: "CODE_INDEXED" });
    if (actor.getSnapshot().value === "waiting-code") {
      emit({ type: "gate", gate: "code" });
      return stoppedSummary(store, config);
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
    signal,
    progress: {
      report(progress): void {
        emit({ type: "progress", done: progress.done, total: progress.total });
      },
    },
  });

  actor.send({ type: "TRANSLATED" });
  emit({ type: "transition", event: "TRANSLATED" });
  emit({ type: "phase", phase: "compose" });
  return summary;
}

/** Narrow production adapter Task 8 can register with the Task 5 runtime. */
export function makeEngineRunner(deps: { backend: LlmBackend }): EngineRunner {
  return async (input) => {
    await runProject({
      store: input.store,
      backend: deps.backend,
      config: input.config,
      ...(input.machineSnapshot === undefined ? {} : { machineSnapshot: input.machineSnapshot }),
      emit: input.emit,
      signal: input.signal,
    });
  };
}
