import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { BabelError, PAUSES_ON } from "../../../core/errors.ts";
import { sha256 } from "../../../core/epub/index.ts";
import { SqliteProjectStore } from "../db/store.ts";
import { composeEpub } from "../compose.ts";
import { classifySystemError } from "../failure.ts";
import { priceTokens } from "../../shared/estimate.ts";
import type { Events } from "../../shared/channels.ts";
import type {
  BackendSpec, EngineHandle, EngineMessage, RunConfig, RunSummary,
} from "../../shared/run.ts";
import { projectCacheKey } from "./cache-key.ts";
import { diagnosticsDir, pruneDiagnostics } from "./diagnostics.ts";
import { configureEngineHost, startEngine } from "./engine-host.ts";
import { makeMachineHost } from "./machine-host.ts";
import { enterState, leaveState } from "./states.ts";
import { modelContextOf, modelPricesOf, reasoningOf } from "../providers/store.ts";
import type { Workspace } from "../workspace.ts";
import type { ProjectEvent } from "../../../core/workflow/project.machine.ts";

export interface RunRuntimeDeps {
  db: DatabaseSync;
  /**
   * What is still an application-wide setting: how many requests go out at
   * once. The two gates used to be here and are now on the project's own row —
   * a book that stops to ask is a decision about that book.
   */
  settings(): { concurrency: number };
  /** The backend materials for a project, key included: they cross the engine port and no other. */
  backendSpec(projectId: string): BackendSpec;
  broadcast<K extends keyof Events>(channel: K, payload: Events[K]): void;
}

interface ProjectRow {
  title: string;
  workspace_path: string;
  source_language: string | null;
  target_language: string;
  source_sha256: string;
  /** The key the run wrote its work under. Null until a run has written one. */
  cache_key: string | null;
  /** 0 or 1: SQLite has no boolean, and the row is read as it was written. */
  auto_accept_terms: number;
  auto_accept_exclusions: number;
}

/**
 * A refusal the interface can name, because it was foreseen.
 *
 * All of these are `config`: something has to change before pressing the
 * button again can work, and now the screen can say what.
 */
class RunRefusedError extends BabelError {
  constructor(code: string) {
    super(code, { code, fault: "config" });
    this.name = "RunRefusedError";
  }
}

function workspaceOf(row: ProjectRow): Workspace {
  return {
    root: row.workspace_path,
    source: `${row.workspace_path}/source.epub`,
    outputDir: `${row.workspace_path}/output`,
    exportDir: `${row.workspace_path}/export`,
  };
}

/** True when the workspace copy still hashes to what the units describe. */
async function sourceMatches(row: ProjectRow): Promise<boolean> {
  try {
    return sha256(await readFile(`${row.workspace_path}/source.epub`)) === row.source_sha256;
  } catch {
    return false;
  }
}

/**
 * Owns the run: the machine beside the database, the engine in its process,
 * and the composition that closes both.
 *
 * The engine's messages drive the main-owned machine; the machine's verdicts
 * are the only thing the library ever reads. One project runs at a time — the
 * engine's command loop is single, and pretending otherwise would have two
 * books silently aborting each other's controller.
 */
export function makeRunRuntime(deps: RunRuntimeDeps): RunRuntime {
  const { db } = deps;
  const listeners = new Set<(message: EngineMessage) => void>();

  let engine: EngineHandle | null = null;
  let activeId: string | null = null;
  let activeRunId: string | null = null;
  /** Identifies the one composer whose eventual result still owns the run. */
  let activeComposition: symbol | null = null;
  /** The engine's accounting, held until the book exists to report it against. */
  let lastSummary: RunSummary | null = null;

  /**
   * Lets go of the engine, all at once.
   *
   * These three say one thing — who owns the engine now — and each ending used
   * to blank a different subset of them. Nothing visible broke, because
   * `onEngineMessage` leaves early on a null `activeId`; but three variables
   * for one fact stay true only if they are set together.
   */
  const release = (): void => {
    activeId = null;
    activeRunId = null;
    activeComposition = null;
  };

  const project = (projectId: string): ProjectRow => {
    const row = db.prepare(`
      SELECT title, workspace_path, source_language, target_language, source_sha256,
             cache_key, auto_accept_terms, auto_accept_exclusions
        FROM project WHERE id = ?
    `).get(projectId) as ProjectRow | undefined;
    if (row === undefined) throw new RunRefusedError("NO_SUCH_PROJECT");
    return row;
  };

  const machineHost = (projectId: string, extra: Record<string, unknown> = {}) => {
    const row = project(projectId);
    return makeMachineHost(db, projectId, {
      autoAcceptTerms: row.auto_accept_terms === 1,
      autoAcceptExclusions: row.auto_accept_exclusions === 1,
      ...extra,
    });
  };

  const feed = (message: EngineMessage): void => {
    for (const listener of listeners) listener(message);
  };

  const changed = (projectId: string): void => {
    deps.broadcast("project.changed", { id: projectId });
  };

  /**
   * The price of a run's tokens, at whatever the model was known to cost when
   * the run began: whatever the catalogue says tomorrow, this book was billed
   * at what was known then, which is what makes yesterday's report still
   * explainable. Null when the run was never priced: an estimate that
   * quietly guessed would be worse than one that says it does not know.
   */
  const costOf = (projectId: string, tokensIn: number, tokensOut: number): number | null => {
    const configured = db.prepare(
      "SELECT provider_id, model_id FROM project WHERE id = ?",
    ).get(projectId) as { provider_id: string | null; model_id: string | null } | undefined;
    const prices = configured?.provider_id != null && configured.model_id != null
      ? modelPricesOf(db, configured.provider_id, configured.model_id)
      : null;
    // The same arithmetic the estimate used before the run started, so the
    // figure quoted beforehand and the one charged afterwards cannot drift
    // apart.
    return prices === null ? null : priceTokens({
      tokensIn, tokensOut, priceIn: prices.priceIn, priceOut: prices.priceOut,
    });
  };

  async function compose(
    projectId: string,
    row: ProjectRow,
    runId: string | null = activeRunId,
  ): Promise<void> {
    if (machineHost(projectId).state !== "composing") return;

    const operation = Symbol("composition");
    activeComposition = operation;
    try {
      const openPhase = db.prepare(`
        SELECT name FROM project_state
         WHERE project_id = ? AND kind = 'phase' AND left_at IS NULL
         ORDER BY entered_at DESC, rowid DESC LIMIT 1
      `).get(projectId) as { name: string } | undefined;
      // A normal run announces this phase before calling us; recomposition and
      // crash recovery enter here directly. Both paths must tell one history.
      if (openPhase?.name !== "compose") {
        enterState(db, { projectId, runId, kind: "phase", name: "compose" });
      }

      // The key the run translated under, which every other screen already reads
      // from here. The source hash names the book, not the work done on it: no
      // translation answers to it, so every unit re-emitted its source.
      if (row.cache_key === null) {
        throw new BabelError("this project has never run under a key", {
          code: "COMPOSE_NO_CACHE_KEY", fault: "defect",
        });
      }

      const result = await composeEpub({
        workspace: workspaceOf(row),
        store: new SqliteProjectStore(db, projectId, runId),
        cacheKey: row.cache_key,
        targetLanguage: row.target_language,
        title: row.title,
      });

      // A crash or pause may have moved the machine while file I/O was in
      // flight. That later result belongs to the abandoned operation.
      if (activeComposition !== operation || activeId !== projectId || activeRunId !== runId) return;
      const current = machineHost(projectId);
      if (current.state !== "composing") return;

      // Kept, not just acted on: this is the evidence of why a gate refused a
      // book, or of which checks a published one passed.
      db.prepare(`
        INSERT INTO project_phase_result (project_id, phase, cache_key, result_json)
        VALUES (?, 'compose', ?, ?)
        ON CONFLICT (project_id, phase, cache_key) DO UPDATE SET
          result_json = excluded.result_json, created_at = excluded.created_at
      `).run(projectId, row.cache_key, JSON.stringify(result));

      if (result.status === "failed") {
        leaveState(db, {
          projectId, kind: "phase", outcome: "failed",
          info: { code: "GATE_REFUSED", fault: "refused" },
        });
        current.send({ type: "FAIL", reason: "GATE_REFUSED" });
      } else {
        leaveState(db, {
          projectId, kind: "phase", outcome: "done", info: { units: lastSummary?.units ?? null },
        });
        current.send({ type: "COMPOSED" });
      }

      release();
      changed(projectId);
      if (result.status !== "failed") {
        feed({
          type: "done",
          summary: lastSummary ?? {
            units: { total: 0, translated: 0, fellBack: 0, identical: 0 },
            notTranslated: {},
            tokensIn: 0,
            tokensOut: 0,
            reasoningTokens: 0,
          },
        });
      }
    } catch (error) {
      if (activeComposition !== operation || activeId !== projectId || activeRunId !== runId) return;
      const classified = classifySystemError(error);
      const ending = PAUSES_ON[classified.fault] ? "paused" : "failed";
      const current = machineHost(projectId);
      if (current.state === "composing") {
        const accepted = current.send(ending === "paused"
          ? { type: "PAUSE", reason: classified.code }
          : { type: "FAIL", reason: classified.code });
        if (accepted) {
          leaveState(db, {
            projectId, kind: "phase", outcome: ending,
            info: { code: classified.code, fault: classified.fault, ...classified.detail },
          });
        }
      }
      release();
      changed(projectId);
    } finally {
      if (activeComposition === operation) activeComposition = null;
    }
  }

  function onEngineMessage(message: EngineMessage): void {
    if (activeId === null) return;

    if (message.type === "transition") {
      machineHost(activeId).send({ type: message.event });
      changed(activeId);
      return;
    }
    if (message.type === "phase") {
      // The engine has one final `done`, not one per phase. Reaching the next
      // phase is therefore the durable evidence that the previous one ended.
      leaveState(db, { projectId: activeId, kind: "phase", outcome: "done" });
      enterState(db, {
        projectId: activeId, runId: activeRunId, kind: "phase", name: message.phase,
      });
      deps.broadcast("run.phase", { projectId: activeId, phase: message.phase });
      if (message.phase === "compose") void compose(activeId, project(activeId), activeRunId);
      return;
    }
    if (message.type === "progress") {
      deps.broadcast("run.progress", {
        projectId: activeId, phase: message.phase, done: message.done, total: message.total,
      });
      return;
    }
    if (message.type === "usage") {
      // Written as it arrives, not at the end. A run that stops at a gate, is
      // paused, or dies with the process has still spent what it spent, and
      // the row is the only place that survives to say so.
      if (activeRunId !== null) {
        const cost = costOf(activeId, message.tokensIn, message.tokensOut);
        db.prepare(
          "UPDATE run SET tokens_in = ?, tokens_out = ?, reasoning_tokens = ?, cost = ? WHERE id = ?",
        ).run(message.tokensIn, message.tokensOut, message.reasoningTokens, cost, activeRunId);
      }
      deps.broadcast("run.usage", {
        projectId: activeId,
        tokensIn: message.tokensIn,
        tokensOut: message.tokensOut,
        reasoningTokens: message.reasoningTokens,
      });
      return;
    }
    if (message.type === "done") {
      // The engine is the only one that counts tokens, and it says so once.
      // Without this the run row keeps its default of zero and every report
      // ever written claims the book cost nothing.
      lastSummary = message.summary;
      if (activeRunId !== null) {
        const cost = costOf(activeId, message.summary.tokensIn, message.summary.tokensOut);
        db.prepare(
          "UPDATE run SET tokens_in = ?, tokens_out = ?, reasoning_tokens = ?, cost = ?, ended_at = ? WHERE id = ?",
        ).run(
          message.summary.tokensIn, message.summary.tokensOut, message.summary.reasoningTokens, cost,
          new Date().toISOString(), activeRunId,
        );
      }
      // The engine is finished before the main-owned composer is. Its summary
      // closes the model process and supplies accounting; the composer alone
      // can close its own phase and release ownership of the project.
      if (machineHost(activeId).state === "composing") return;

      leaveState(db, {
        projectId: activeId, kind: "phase", outcome: "done", info: { units: message.summary.units },
      });
      // The engine's turn is over, whether it finished the book or stopped at
      // a gate. Leaving `activeId` set would make the next approval refuse
      // itself with ENGINE_BUSY — a gate that can be opened but never closed.
      const finished = activeId;
      release();

      // Not fed onward: `done` is what tells the user their book is ready, and
      // the book is not ready until the composer has written and checked it.
      changed(finished);
      return;
    }
    if (message.type === "gate") {
      changed(activeId);
      feed(message);
      return;
    }
    if (message.type === "failed") {
      const projectId = activeId;
      // The taxonomy's table, read here and nowhere else. `failed` means
      // "resuming would not fix it", and only three faults qualify: a network
      // that went away is a pause, and used to be a rejection.
      const ending = PAUSES_ON[message.fault] ? "paused" : "failed";
      const info = {
        code: message.code, fault: message.fault, ...(message.detail ?? {}),
      };

      const host = machineHost(projectId);
      const accepted = host.send(ending === "paused"
        ? { type: "PAUSE", reason: message.code }
        : { type: "FAIL", reason: message.code });
      // Written only if the machine lived through it: a state recorded that
      // the machine refused is a history that did not happen.
      if (accepted) leaveState(db, { projectId, kind: "phase", outcome: ending, info });

      release();
      changed(projectId);
      return;
    }
  }

  async function onCrash(projectId: string): Promise<void> {
    db.exec("SAVEPOINT babelbook_engine_crash");
    try {
      // Sent before anything is written: a state recorded that the machine
      // refused is a history that did not happen.
      const accepted = machineHost(projectId).send({ type: "PAUSE" });
      if (accepted) leaveState(db, { projectId, kind: "phase", outcome: "paused" });
      if (activeRunId !== null) {
        db.prepare(`
          INSERT INTO run_event (id, run_id, at, code, severity, payload_json)
          VALUES (?, ?, ?, 'engine-exited', 'degradation', '{}')
        `).run(randomUUID(), activeRunId, new Date().toISOString());
      }
      db.exec("RELEASE SAVEPOINT babelbook_engine_crash");
    } catch (error) {
      db.exec("ROLLBACK TO SAVEPOINT babelbook_engine_crash");
      db.exec("RELEASE SAVEPOINT babelbook_engine_crash");
      throw error;
    }
    release();
    changed(projectId);
  }

  configureEngineHost({
    storeFor: () => new SqliteProjectStore(db, activeId ?? "", activeRunId),
    onCrash,
  });

  function launch(projectId: string, row: ProjectRow): void {
    const runId = randomUUID();
    db.prepare("INSERT INTO run (id, project_id, phase, started_at) VALUES (?,?,'translate',?)")
      .run(runId, projectId, new Date().toISOString());
    // Best-effort, at the start rather than the end: the pruning of old
    // diaries must never be the thing a run waits on, and a run that is
    // starting is the only moment that knows how many came before.
    void pruneDiagnostics(diagnosticsDir(row.workspace_path));

    if (engine === null || !engine.alive) {
      engine = startEngine();
      engine.on(onEngineMessage);
    }

    const settings = deps.settings();
    // The model's declared window, when there is one to read: it reaches the
    // planner, which can only use it to cut smaller — never to merge more.
    const configured = db.prepare(
      "SELECT provider_id, model_id FROM project WHERE id = ?",
    ).get(projectId) as { provider_id: string | null; model_id: string | null } | undefined;
    const contextWindowTokens = configured?.provider_id != null && configured.model_id != null
      ? modelContextOf(db, configured.provider_id, configured.model_id)
      : null;
    const reasoning = configured?.provider_id != null && configured.model_id != null
      ? reasoningOf(db, configured.provider_id, configured.model_id)
      : "off";

    // The backend is resolved before the key, because the model it names is
    // part of the key: the same book translated by another model is other
    // work, and reusing one for the other is not a saving but a mixture.
    const backend = deps.backendSpec(projectId);
    const key = projectCacheKey(
      db, projectId, backend.kind === "sdk" ? backend.spec : "fake", reasoning,
      backend.kind === "sdk" && backend.structured ? "schema" : "text",
    );
    // Written down, because every screen reads the key from here: the library
    // counts progress under it, the units tab shows translations under it, and
    // the report is built from it. A key computed and not stored would leave
    // all three answering about whatever key they happened to find.
    db.prepare("UPDATE project SET cache_key = ? WHERE id = ?").run(key, projectId);

    const config: RunConfig = {
      projectId,
      cacheKey: key,
      sourceLanguage: row.source_language ?? "en",
      targetLanguage: row.target_language,
      autoAcceptTerms: row.auto_accept_terms === 1,
      autoAcceptExclusions: row.auto_accept_exclusions === 1,
      concurrency: settings.concurrency,
      contextWindowTokens,
    };

    activeId = projectId;
    activeRunId = runId;
    engine.send({
      type: "start",
      projectId,
      runId,
      workspaceRoot: row.workspace_path,
      config,
      backend,
      machineSnapshot: machineHost(projectId).snapshot,
    });
    changed(projectId);
  }

  return {
    get active(): string | null {
      return activeId;
    },

    onMessage(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start(projectId): Promise<void> {
      if (activeId === projectId) throw new RunRefusedError("ALREADY_RUNNING");
      if (activeId !== null) throw new RunRefusedError("ENGINE_BUSY");

      const row = project(projectId);
      const host = machineHost(projectId);

      if (host.state === "composing") {
        activeId = projectId;
        await compose(projectId, row);
        return;
      }

      let accepted = true;
      if (host.state === "ready") {
        accepted = host.send({ type: "START" });
      } else if (host.state === "paused" || host.state === "failed") {
        // A stop is exactly the window in which the file on disk has time to
        // change, so the hash is recomputed before the machine is asked. A run
        // that failed is picked up the same way a paused one is: what it
        // managed to translate is in the store under the key the next run
        // reads, so resuming costs only what is left.
        if (!(await sourceMatches(row))) throw new RunRefusedError("SOURCE_CHANGED");
        accepted = host.send({ type: "RESUME" });
      } else if (host.state === "waiting-terms" || host.state === "waiting-code") {
        throw new RunRefusedError("GATE_OPEN");
      } else if (host.state === "new" || host.state === "needs-language") {
        throw new RunRefusedError("NO_LANGUAGE");
      } else if (host.state === "running") {
        throw new RunRefusedError("ALREADY_RUNNING");
      } else {
        throw new RunRefusedError(`RUN_STATE_${host.state.toUpperCase()}`);
      }

      if (!accepted) throw new RunRefusedError("MACHINE_REFUSED");
      launch(projectId, row);
    },

    /**
     * The composition again, over the translations already held.
     *
     * No model is asked anything: the phase reads the store and writes an
     * EPUB. It is how a book composed wrong stops being composed wrong
     * without paying for its translation twice.
     */
    async recompose(projectId): Promise<void> {
      if (activeId !== null) throw new RunRefusedError("ENGINE_BUSY");

      const host = machineHost(projectId);
      if (!host.send({ type: "COMPOSE" })) {
        throw new RunRefusedError(`RUN_STATE_${host.state.toUpperCase()}`);
      }

      activeId = projectId;
      try {
        await compose(projectId, project(projectId));
      } finally {
        release();
      }
    },

    async pause(projectId): Promise<void> {
      if (activeId === projectId && engine !== null && engine.alive) {
        engine.send({ type: "pause" });
      }
      db.exec("SAVEPOINT babelbook_pause_run");
      try {
        // Sent before anything is written: a state recorded that the machine
        // refused is a history that did not happen.
        const accepted = machineHost(projectId).send({ type: "PAUSE" });
        if (accepted) leaveState(db, { projectId, kind: "phase", outcome: "paused" });
        db.exec("RELEASE SAVEPOINT babelbook_pause_run");
      } catch (error) {
        db.exec("ROLLBACK TO SAVEPOINT babelbook_pause_run");
        db.exec("RELEASE SAVEPOINT babelbook_pause_run");
        throw error;
      }
      if (activeId === projectId) release();
      changed(projectId);
    },

    async approve(projectId, gate): Promise<void> {
      if (activeId !== null) throw new RunRefusedError("ENGINE_BUSY");
      const host = machineHost(projectId);
      const event: ProjectEvent = gate === "terms"
        ? { type: "TERMS_APPROVED" }
        : { type: "CODE_REVIEWED" };
      if (!host.send(event)) throw new RunRefusedError("GATE_CLOSED");
      launch(projectId, project(projectId));
    },

    async shutdown(): Promise<void> {
      if (activeId !== null) await this.pause(activeId);
      await engine?.kill();
    },
  };
}

export interface RunRuntime {
  readonly active: string | null;
  onMessage(listener: (message: EngineMessage) => void): () => void;
  start(projectId: string): Promise<void>;
  recompose(projectId: string): Promise<void>;
  pause(projectId: string): Promise<void>;
  approve(projectId: string, gate: "terms" | "code"): Promise<void>;
  /** Pauses what runs, kills the engine, and answers when both are done. */
  shutdown(): Promise<void>;
}
