import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { createProject } from "../main/projects/create.ts";
import { configureEngineHost } from "../main/run/engine-host.ts";
import { makeRunRuntime } from "../main/run/runtime.ts";
import { statesOf } from "../main/run/states.ts";
import type { EngineMessage, MessagePortLike } from "../shared/run.ts";

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
  const port: MessagePortLike = {
    postMessage: () => {},
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
    settings: () => ({ autoAcceptTerms: true, autoAcceptExclusions: true, concurrency: 2 }),
    backendSpec: () => ({ kind: "fake" }),
    broadcast: () => {},
  });
  await runtime.start(created.id);
  return { db, id: created.id, engine, runtime };
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
    engine.emit({ type: "failed", code: "provider-529" });

    expect(statesOf(db, id).find((state) => state.kind === "phase" && state.name === "translate"))
      .toMatchObject({ outcome: "failed", info: { code: "provider-529" } });
    expect(statesOf(db, id).filter((state) => state.kind === "project").at(-1))
      .toMatchObject({ name: "failed" });
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
