import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "../../../core/epub/index.ts";
import { SqliteProjectStore } from "../db/store.ts";
import { composeEpub } from "../compose.ts";
import { priceTokens } from "../../shared/estimate.ts";
import type { Events } from "../../shared/channels.ts";
import type {
  BackendSpec, EngineHandle, EngineMessage, RunConfig, RunSummary,
} from "../../shared/run.ts";
import { projectCacheKey } from "./cache-key.ts";
import { configureEngineHost, startEngine } from "./engine-host.ts";
import { makeMachineHost } from "./machine-host.ts";
import { modelContextOf, modelPricesOf } from "../providers/store.ts";
import type { Workspace } from "../workspace.ts";
import type { ProjectEvent } from "../../../core/workflow/project.machine.ts";

export interface RunRuntimeDeps {
  db: DatabaseSync;
  settings(): { autoAcceptTerms: boolean; autoAcceptExclusions: boolean; concurrency: number };
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
}

/** A failure the interface can name, because it was foreseen. */
class RunRefusedError extends Error {
  constructor(readonly code: string) {
    super(code);
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
  /** The engine's accounting, held until the book exists to report it against. */
  let lastSummary: RunSummary | null = null;

  const project = (projectId: string): ProjectRow => {
    const row = db.prepare(`
      SELECT title, workspace_path, source_language, target_language, source_sha256
        FROM project WHERE id = ?
    `).get(projectId) as ProjectRow | undefined;
    if (row === undefined) throw new RunRefusedError("NO_SUCH_PROJECT");
    return row;
  };

  const machineHost = (projectId: string, extra: Record<string, unknown> = {}) => {
    const settings = deps.settings();
    return makeMachineHost(db, projectId, {
      autoAcceptTerms: settings.autoAcceptTerms,
      autoAcceptExclusions: settings.autoAcceptExclusions,
      ...extra,
    });
  };

  const feed = (message: EngineMessage): void => {
    for (const listener of listeners) listener(message);
  };

  const changed = (projectId: string): void => {
    deps.broadcast("project.changed", { id: projectId });
  };

  async function compose(projectId: string, row: ProjectRow): Promise<void> {
    const host = machineHost(projectId);
    if (host.state !== "composing") return;

    const result = await composeEpub({
      workspace: workspaceOf(row),
      store: new SqliteProjectStore(db, projectId, activeRunId),
      cacheKey: row.source_sha256,
      targetLanguage: row.target_language,
      title: row.title,
    });

    // Kept, not just acted on. The invariants, the EPUBCheck verdict and the
    // path are the only evidence of why a gate refused a book — or of which
    // checks a published one passed — and the report has nowhere else to read
    // them from. Written before the transition, so a crash in between leaves
    // the evidence rather than the claim.
    db.prepare(`
      INSERT INTO project_phase_result (project_id, phase, cache_key, result_json)
      VALUES (?, 'compose', ?, ?)
      ON CONFLICT (project_id, phase, cache_key) DO UPDATE SET
        result_json = excluded.result_json, created_at = excluded.created_at
    `).run(projectId, row.source_sha256, JSON.stringify(result));

    // COMPOSED is claimed only after the book was written and validated; a
    // gate that refuses leaves the file behind for inspection and fails the run.
    if (result.status === "failed") host.send({ type: "FAIL", reason: "GATE_REFUSED" });
    else host.send({ type: "COMPOSED" });

    activeId = null;
    changed(projectId);
    if (result.status !== "failed") {
      feed({
        type: "done",
        summary: lastSummary ?? {
          units: { total: 0, translated: 0, fellBack: 0, identical: 0 },
          notTranslated: {},
          tokensIn: 0,
          tokensOut: 0,
        },
      });
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
      deps.broadcast("run.phase", { projectId: activeId, phase: message.phase });
      if (message.phase === "compose") void compose(activeId, project(activeId));
      return;
    }
    if (message.type === "progress") {
      deps.broadcast("run.progress", { projectId: activeId, done: message.done, total: message.total });
      return;
    }
    if (message.type === "done") {
      // The engine is the only one that counts tokens, and it says so once.
      // Without this the run row keeps its default of zero and every report
      // ever written claims the book cost nothing.
      lastSummary = message.summary;
      if (activeRunId !== null) {
        // The price is the model's as saved when the run began: whatever the
        // catalogue says tomorrow, this book was billed at what was known
        // then, which is what makes yesterday's report still explainable.
        const configured = db.prepare(
          "SELECT provider_id, model_id FROM project WHERE id = ?",
        ).get(activeId) as { provider_id: string | null; model_id: string | null } | undefined;
        const prices = configured?.provider_id != null && configured.model_id != null
          ? modelPricesOf(db, configured.provider_id, configured.model_id)
          : null;
        // The same arithmetic the estimate used before the run started, so
        // the figure quoted beforehand and the one charged afterwards cannot
        // drift apart.
        const cost = prices === null ? null : priceTokens({
          tokensIn: message.summary.tokensIn,
          tokensOut: message.summary.tokensOut,
          priceIn: prices.priceIn,
          priceOut: prices.priceOut,
        });

        db.prepare(
          "UPDATE run SET tokens_in = ?, tokens_out = ?, cost = ?, ended_at = ? WHERE id = ?",
        ).run(
          message.summary.tokensIn, message.summary.tokensOut, cost,
          new Date().toISOString(), activeRunId,
        );
      }
      // The engine's turn is over, whether it finished the book or stopped at
      // a gate. Leaving `activeId` set would make the next approval refuse
      // itself with ENGINE_BUSY — a gate that can be opened but never closed.
      const finished = activeId;
      activeId = null;

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
      machineHost(projectId).send({ type: "FAIL", reason: message.code });
      activeId = null;
      changed(projectId);
    }
  }

  async function onCrash(projectId: string): Promise<void> {
    const host = machineHost(projectId);
    host.send({ type: "PAUSE" });
    if (activeRunId !== null) {
      db.prepare(`
        INSERT INTO run_event (id, run_id, at, code, severity, payload_json)
        VALUES (?, ?, ?, 'engine-exited', 'degradation', '{}')
      `).run(randomUUID(), activeRunId, new Date().toISOString());
    }
    activeId = null;
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

    // The backend is resolved before the key, because the model it names is
    // part of the key: the same book translated by another model is other
    // work, and reusing one for the other is not a saving but a mixture.
    const backend = deps.backendSpec(projectId);
    const key = projectCacheKey(db, projectId, backend.kind === "sdk" ? backend.spec : "fake");
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
      autoAcceptTerms: settings.autoAcceptTerms,
      autoAcceptExclusions: settings.autoAcceptExclusions,
      concurrency: settings.concurrency,
      contextWindowTokens,
    };

    activeId = projectId;
    activeRunId = runId;
    engine.send({
      type: "start",
      projectId,
      config,
      backend,
      machineSnapshot: machineHost(projectId).snapshot,
    });
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
      } else if (host.state === "paused") {
        // A pause is exactly the window in which the file on disk has time to
        // change, so the hash is recomputed before the machine is asked.
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

    async pause(projectId): Promise<void> {
      if (activeId === projectId && engine !== null && engine.alive) {
        engine.send({ type: "pause" });
      }
      machineHost(projectId).send({ type: "PAUSE" });
      if (activeId === projectId) activeId = null;
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
  pause(projectId: string): Promise<void>;
  approve(projectId: string, gate: "terms" | "code"): Promise<void>;
  /** Pauses what runs, kills the engine, and answers when both are done. */
  shutdown(): Promise<void>;
}
