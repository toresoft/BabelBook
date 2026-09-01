import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { createProject } from "../main/projects/create.ts";
import { configureEngineHost } from "../main/run/engine-host.ts";
import { makeRunRuntime } from "../main/run/runtime.ts";
import { enterState, statesOf, type StateRecord } from "../main/run/states.ts";
import type { EngineMessage, MessagePortLike, RunConfig } from "../shared/run.ts";

const composition = vi.hoisted(() => {
  let resolve: (result: unknown) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  return {
    next: () => new Promise<unknown>((done, fail) => { resolve = done; reject = fail; }),
    resolve: (result: unknown) => resolve(result),
    reject: (error: unknown) => reject(error),
  };
});

vi.mock("../main/compose.ts", () => ({
  composeEpub: () => composition.next(),
}));

const restore: Array<() => void> = [];

afterEach(() => {
  while (restore.length > 0) restore.pop()?.();
});

function fakeEngine() {
  let receive: ((event: { data: unknown }) => void) | undefined;
  let exited: ((code: number) => void) | undefined;
  const sent: unknown[] = [];
  const port: MessagePortLike = {
    // `makeEngineHost` sends every command down port1, so this is where the
    // start command — and the config the runtime built — actually goes.
    postMessage: (message) => { sent.push(message); },
    on: (_event, listener) => { receive = listener; },
    start: () => {},
    close: () => {},
  };
  const other: MessagePortLike = { postMessage: () => {}, on: () => {} };

  restore.push(configureEngineHost({
    enginePath: "fake-engine",
    fork: () => ({
      postMessage: () => {},
      kill: () => { exited?.(0); return true; },
      on: (_event, listener) => { exited = listener; },
      off: () => {},
    }),
    makeChannel: () => ({ port1: port, port2: other }),
  }));

  return {
    sent,
    emit(message: EngineMessage): void {
      if (receive === undefined) throw new Error("engine is not connected");
      receive({ data: message });
    },
    crash(): void {
      exited?.(1);
    },
  };
}

async function running() {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-run-state-"));
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO provider (id, name, route, headers, options)
    VALUES ('pv1', 'Acme', 'openai-compatible', '{}', '{}')
  `).run();
  db.prepare(`
    INSERT INTO provider_model (id, provider_id, model_id, display_name)
    VALUES ('pm1', 'pv1', 'm1', 'M1')
  `).run();
  const epubPath = join(dir, "book.epub");
  await writeFile(epubPath, await buildEpub({
    title: "The Book", language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
  }));
  const created = await createProject(db, dir, {
    epubPath, targetLanguage: "it", providerId: "pv1", modelId: "m1",
  });
  const engine = fakeEngine();
  const runtime = makeRunRuntime({
    db,
    // The two gates used to be read from here. This object is now the whole of
    // what the runtime is allowed to ask the application.
    settings: () => ({ concurrency: 2 }),
    backendSpec: () => ({ kind: "fake" }),
    broadcast: () => {},
  });
  await runtime.start(created.id);
  return { db, id: created.id, engine, runtime };
}

/**
 * Two projects ready to run, and the ear the runtime gives the engine.
 *
 * The ids are fixed because the tests below are about ownership: the project
 * a run belongs to and the one made to wait are easier to tell apart as p1
 * and p2 than as two generated ids. Each is given the open `translate` phase
 * a live run announces, so that whatever ends the run lands on a phase that
 * exists — the history a pause or a failure is written into. The workspaces
 * are paths that exist nowhere: a run in these tests owns no files, and the
 * diagnostics pruning is best-effort by design.
 */
function harness() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO provider (id, name, route, headers, options)
    VALUES ('pv1', 'Acme', 'openai-compatible', '{}', '{}')
  `).run();
  db.prepare(`
    INSERT INTO provider_model (id, provider_id, model_id, display_name)
    VALUES ('pm1', 'pv1', 'm1', 'M1')
  `).run();
  for (const id of ["p1", "p2"] as const) {
    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           source_language, target_language, state, layout)
      VALUES (?, ?, ?, ?, ?, ?, 'en', 'it', 'ready', 'reflowable')
    `).run(id, `${id}.epub`, id === "p1" ? "One" : "Two", `/${id}`, `sha-${id}`,
      "2026-09-01T09:00:00.000Z");
    enterState(db, { projectId: id, kind: "phase", name: "translate" });
  }
  const engine = fakeEngine();
  const runtime = makeRunRuntime({
    db,
    settings: () => ({ concurrency: 2 }),
    backendSpec: () => ({ kind: "fake" }),
    broadcast: () => {},
  });
  return {
    db,
    runtime,
    /** Speaks to the runtime as the engine would: through the listener `on` registered. */
    feed: (message: EngineMessage): void => { engine.emit(message); },
  };
}

/** The project's state as the library reads it: the machine's verdict, kept on the row. */
function stateOf(db: DatabaseSync, projectId: string): string {
  const row = db.prepare("SELECT state FROM project WHERE id = ?").get(projectId) as
    { state: string } | undefined;
  if (row === undefined) throw new Error(`no such project: ${projectId}`);
  return row.state;
}

/** The last phase of the history: the row a pause or a failure is written into. */
function lastPhase(db: DatabaseSync, projectId: string): StateRecord {
  const last = statesOf(db, projectId).filter((state) => state.kind === "phase").at(-1);
  if (last === undefined) throw new Error(`no phase in the history of ${projectId}`);
  return last;
}

describe("the runtime's state history", () => {
  it("keeps the run until asynchronous composition has actually ended", async () => {
    const { db, id, engine, runtime } = await running();

    engine.emit({ type: "transition", event: "TRANSLATED" });
    engine.emit({ type: "phase", phase: "compose" });
    engine.emit({
      type: "done",
      summary: {
        units: { total: 1, translated: 1, fellBack: 0, identical: 0 },
        notTranslated: {}, tokensIn: 12, tokensOut: 8, reasoningTokens: 0,
      },
    });

    expect(runtime.active).toBe(id);
    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "compose"))
      .toMatchObject({ outcome: null, leftAt: null });

    composition.resolve({ status: "complete" });
    await vi.waitFor(() => expect(runtime.active).toBeNull());
    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "compose"))
      .toMatchObject({ outcome: "done", leftAt: expect.any(String) });
  });

  it("fails the phase and releases the run when composition rejects", async () => {
    const { db, id, engine, runtime } = await running();

    engine.emit({ type: "transition", event: "TRANSLATED" });
    engine.emit({ type: "phase", phase: "compose" });
    engine.emit({
      type: "done",
      summary: {
        units: { total: 1, translated: 1, fellBack: 0, identical: 0 },
        notTranslated: {}, tokensIn: 12, tokensOut: 8, reasoningTokens: 0,
      },
    });
    composition.reject(Object.assign(new Error("disk full"), { code: "DISK_FULL" }));

    await vi.waitFor(() => expect(runtime.active).toBeNull());
    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "compose"))
      .toMatchObject({ outcome: "failed", info: { code: "DISK_FULL" } });
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1))
      .toMatchObject({ name: "failed" });
  });

  it("does not let a stale composition overwrite a crash pause", async () => {
    const { db, id, engine, runtime } = await running();

    engine.emit({ type: "transition", event: "TRANSLATED" });
    engine.emit({ type: "phase", phase: "compose" });
    engine.crash();
    await vi.waitFor(() => expect(runtime.active).toBeNull());
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1))
      .toMatchObject({ name: "paused" });

    composition.resolve({ status: "complete" });
    await Promise.resolve();
    await Promise.resolve();
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1))
      .toMatchObject({ name: "paused" });
    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "compose"))
      .toMatchObject({ outcome: "paused" });
  });

  it("does not apply an old composition to a restarted run of the same project", async () => {
    const { db, id, engine, runtime } = await running();

    engine.emit({ type: "transition", event: "TRANSLATED" });
    engine.emit({ type: "phase", phase: "compose" });
    engine.crash();
    await vi.waitFor(() => expect(runtime.active).toBeNull());

    await runtime.start(id);
    engine.emit({ type: "transition", event: "TRANSLATED" });
    expect(runtime.active).toBe(id);
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1))
      .toMatchObject({ name: "composing" });

    // This resolves the abandoned first run; the restarted run has not begun
    // its own compose phase yet and must keep ownership.
    composition.resolve({ status: "complete" });
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.active).toBe(id);
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1))
      .toMatchObject({ name: "composing" });
    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "compose"))
      .toMatchObject({ outcome: "paused" });
  });

  it("does not abandon the active composition when another project is paused", async () => {
    const { db, id, engine, runtime } = await running();
    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           source_language, target_language, state, layout)
      VALUES ('p2', 'other.epub', 'Other', '/w2', 'sha2', '2026-08-30T09:00:00.000Z',
              'en', 'it', 'ready', 'reflowable')
    `).run();

    engine.emit({ type: "transition", event: "TRANSLATED" });
    engine.emit({ type: "phase", phase: "compose" });
    engine.emit({
      type: "done",
      summary: {
        units: { total: 1, translated: 1, fellBack: 0, identical: 0 },
        notTranslated: {}, tokensIn: 12, tokensOut: 8, reasoningTokens: 0,
      },
    });

    await runtime.pause("p2");
    expect(runtime.active).toBe(id);

    composition.resolve({ status: "complete" });
    await vi.waitFor(() => expect(runtime.active).toBeNull());
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1)?.name)
      .toMatch(/^(done|incomplete)$/);
  });

  it("finishes one phase when the engine enters the next", async () => {
    const { db, id, engine } = await running();

    engine.emit({ type: "phase", phase: "candidates" });
    engine.emit({ type: "phase", phase: "code-index" });

    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "candidates"))
      .toMatchObject({ outcome: "done", leftAt: expect.any(String) });
    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "code-index"))
      .toMatchObject({ outcome: null, leftAt: null });
  });

  it("records the run starting and closes a phase when the engine is done", async () => {
    const { db, id, engine } = await running();

    engine.emit({ type: "phase", phase: "translate" });
    engine.emit({
      type: "done",
      summary: {
        units: { total: 3, translated: 2, fellBack: 1, identical: 0 },
        notTranslated: {}, tokensIn: 40, tokensOut: 20, reasoningTokens: 0,
      },
    });

    expect(statesOf(db, id).filter((state) => state.kind === "project").map((state) => state.name))
      .toEqual(["ready", "running"]);
    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "translate"))
      .toMatchObject({ outcome: "done", info: { units: { total: 3, translated: 2 } } });
  });

  it("records why a phase failed", async () => {
    const { db, id, engine } = await running();

    engine.emit({ type: "phase", phase: "translate" });
    engine.emit({ type: "failed", code: "provider-529", fault: "defect" });

    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "translate"))
      .toMatchObject({ outcome: "failed", info: { code: "provider-529" } });
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1))
      .toMatchObject({ name: "failed" });
  });

  /**
   * The half a run got through is the reason to offer it again.
   *
   * A translation that died on a provider error left its units in the store,
   * under the key the next run will look them up by. Refusing to start meant
   * the only thing on offer was composing a book that was mostly the original
   * — and paying for the whole translation again was not on offer at all.
   */
  it("picks a failed run back up, and keeps what it had already translated", async () => {
    const { db, id, engine, runtime } = await running();

    engine.emit({ type: "phase", phase: "translate" });
    engine.emit({ type: "failed", code: "provider-529", fault: "defect" });
    expect((db.prepare("SELECT state FROM project WHERE id = ?").get(id) as { state: string }).state)
      .toBe("failed");

    await runtime.start(id);

    expect((db.prepare("SELECT state FROM project WHERE id = ?").get(id) as { state: string }).state)
      .toBe("running");
    // The key is not rewritten into something else on the way back in: the
    // stored translations are found under it, or resuming pays twice.
    expect(statesOf(db, id).filter((state) => state.kind === "project").map((state) => state.name))
      .toEqual(["ready", "running", "failed", "running"]);
  });

  it("closes the active phase when a run is paused", async () => {
    const { db, id, engine, runtime } = await running();

    engine.emit({ type: "phase", phase: "translate" });
    await runtime.pause(id);

    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "translate"))
      .toMatchObject({ outcome: "paused" });
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1))
      .toMatchObject({ name: "paused" });
  });

  it("closes the active phase when the engine exits unexpectedly", async () => {
    const { db, id, engine, runtime } = await running();

    engine.emit({ type: "phase", phase: "translate" });
    engine.crash();

    await vi.waitFor(() => expect(runtime.active).toBeNull());
    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "translate"))
      .toMatchObject({ outcome: "paused", leftAt: expect.any(String) });
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1))
      .toMatchObject({ name: "paused" });
  });
});

describe("a run that stops", () => {
  /**
   * The cut the taxonomy exists for. Credit that ran out is not a rejected
   * book: resuming tomorrow finishes it, and the badge must not say
   * "Rifiutato" of a book nobody rejected.
   */
  it("pauses when resuming would fix it", async () => {
    const { runtime, db, feed } = harness();
    await runtime.start("p1");

    feed({ type: "failed", code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted" });

    expect(stateOf(db, "p1")).toBe("paused");
    const phase = lastPhase(db, "p1");
    expect(phase.outcome).toBe("paused");
    expect(phase.info).toMatchObject({ code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted" });
  });

  it("fails when resuming would not", async () => {
    const { runtime, db, feed } = harness();
    await runtime.start("p1");

    feed({ type: "failed", code: "GATE_REFUSED", fault: "refused" });

    expect(stateOf(db, "p1")).toBe("failed");
    expect(lastPhase(db, "p1").info).toMatchObject({ fault: "refused" });
  });

  /** Three variables that mean "who owns the engine" must go blank together. */
  it("lets go of the engine on every ending", async () => {
    const { runtime, feed } = harness();
    await runtime.start("p1");
    feed({ type: "failed", code: "PROVIDER_UNREACHABLE", fault: "transient" });

    expect(runtime.active).toBeNull();
    await expect(runtime.start("p2")).resolves.toBeUndefined();
  });

  /**
   * A project already paused refuses another PAUSE, and writing the state
   * anyway records something the machine never lived through.
   */
  it("does not write a pause the machine refused", async () => {
    const { runtime, db } = harness();
    await runtime.start("p1");
    await runtime.pause("p1");
    const first = lastPhase(db, "p1");

    await runtime.pause("p1");

    expect(lastPhase(db, "p1")).toEqual(first);
  });

  it("refuses with a class the screen can act on", async () => {
    const { runtime } = harness();
    await runtime.start("p1");
    await expect(runtime.start("p2")).rejects.toMatchObject({
      code: "ENGINE_BUSY", fault: "config",
    });
  });
});

describe("where the runtime reads the two gates", () => {
  it("takes them off the project's row, and not off the settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babelbook-run-gates-"));
    const db = openDatabase(":memory:");
    migrate(db, loadMigrations("app/main/db/migrations"));
    db.prepare(`
      INSERT INTO provider (id, name, route, headers, options)
      VALUES ('pv1', 'Acme', 'openai-compatible', '{}', '{}')
    `).run();
    db.prepare(`
      INSERT INTO provider_model (id, provider_id, model_id, display_name)
      VALUES ('pm1', 'pv1', 'm1', 'M1')
    `).run();

    const epubPath = join(dir, "book.epub");
    await writeFile(epubPath, await buildEpub({
      title: "The Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    }));
    const created = await createProject(db, dir, {
      epubPath, targetLanguage: "it", providerId: "pv1", modelId: "m1",
    });

    // One closed, one open: two booleans read from one place would both be
    // right by accident if the place were the wrong one.
    db.prepare(`
      UPDATE project SET auto_accept_terms = 0, auto_accept_exclusions = 1 WHERE id = ?
    `).run(created.id);

    const engine = fakeEngine();
    const runtime = makeRunRuntime({
      db,
      settings: () => ({ concurrency: 2 }),
      backendSpec: () => ({ kind: "fake" }),
      broadcast: () => {},
    });
    await runtime.start(created.id);

    const start = engine.sent.find((message) =>
      (message as { type?: string }).type === "start") as { config: RunConfig };
    expect(start.config).toMatchObject({ autoAcceptTerms: false, autoAcceptExclusions: true });
  });
});
