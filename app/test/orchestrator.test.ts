import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { TranslationUnit } from "../../core/epub/index.ts";
import { FakeBackend } from "../../core/test/fake/backend.ts";
import { FakeStore } from "../../core/test/fake/store.ts";
import { createProjectActor } from "../../core/workflow/project.machine.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { SqliteProjectStore } from "../main/db/store.ts";
import {
  makeMachineHost, restoreRunningProjects, USER_EVENTS,
} from "../main/run/machine-host.ts";
import { makeEngineRunner, runProject } from "../main/run/orchestrator.ts";
import type { EngineMessage, RunConfig } from "../shared/run.ts";

const unit = (n: number): TranslationUnit => ({
  id: `c1.xhtml#${n}`,
  kind: "block",
  doc: "c1.xhtml",
  ordinal: n,
  range: [n * 100, n * 100 + 20],
  source: `Sentence ${n}`,
  raw: `Sentence ${n}`,
  state: "translate",
});

const config = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  projectId: "p1",
  cacheKey: "k1",
  sourceLanguage: "en",
  targetLanguage: "it",
  autoAcceptTerms: false,
  autoAcceptExclusions: false,
  concurrency: 1,
  ...overrides,
});

function scriptedBackend(): FakeBackend {
  return new FakeBackend((call) => {
    if (call.prompt.includes("TERMS")) {
      return { text: "TERMS 0\nEND", tokensIn: 10, tokensOut: 5, reasoningTokens: 0, finishReason: "stop" };
    }
    if (call.prompt.includes("VERDICTS")) {
      return {
        text: "VERDICTS 1\n[v:c1.xhtml#1] prose\nEND",
        tokensIn: 10,
        tokensOut: 5,
        reasoningTokens: 0,
        finishReason: "stop",
      };
    }
    return {
      text: "UNITS 1\n[u:c1.xhtml#1]\nFrase 1\nEND",
      tokensIn: 10,
      tokensOut: 5,
      reasoningTokens: 0,
      finishReason: "stop",
    };
  });
}

function collect(): { seen: EngineMessage[]; emit: (message: EngineMessage) => void } {
  const seen: EngineMessage[] = [];
  return { seen, emit: (message) => seen.push(message) };
}

function database(): DatabaseSync {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  return db;
}

function insertProject(db: DatabaseSync, state = "ready", snapshot: unknown = null): void {
  db.prepare(`
    INSERT INTO project (
      id, filename, title, workspace_path, source_sha256, created_at,
      source_language, target_language, state, machine_snapshot
    ) VALUES ('p1','a.epub','A','/w','h','2026-08-24','en','it',?,?)
  `).run(state, snapshot === null ? null : JSON.stringify(snapshot));
}

describe("runProject", () => {
  // Production break: phase code ignores waiting-terms and starts model-backed code indexing or translation.
  // Production break: the summary a gate returns counts a stored fallback as a translation.
  it("does not report a held fallback as translated when it stops at a gate", async () => {
    const store = new FakeStore([unit(1)]);
    await store.putTranslation({
      unitId: "c1.xhtml#1", text: "Frase 1", cacheKey: "k1", attempts: 3, outcome: "fell-back",
    });
    const { emit } = collect();

    const summary = await runProject({
      store,
      backend: scriptedBackend(),
      config: config(),
      emit,
      signal: new AbortController().signal,
    });

    expect(summary.units.translated).toBe(0);
    expect(summary.units.fellBack).toBe(1);
  });

  it("returns at the terms gate without spending on a later phase", async () => {
    const store = new FakeStore([unit(1)]);
    const backend = scriptedBackend();
    const { seen, emit } = collect();

    await runProject({
      store,
      backend,
      config: config(),
      emit,
      signal: new AbortController().signal,
    });

    expect(seen).toContainEqual({ type: "gate", gate: "terms" });
    expect(seen).toContainEqual({ type: "transition", event: "TERMS_READY" });
    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain("TERMS");
    expect((await store.translations("k1")).size).toBe(0);
  });

  // Production break: a paid non-empty candidate report disappears before the user can review it.
  it("persists a non-empty candidate report as pending before the manual terms gate", async () => {
    const store = new FakeStore([{
      ...unit(1), source: "They reached Rivendell.", raw: "They reached Rivendell.",
    }]);
    const backend = new FakeBackend(() => ({
      text: "TERMS 1\n[t:Rivendell] rule=dnt note=proper name\nOPEN 0\nEND",
      tokensIn: 10,
      tokensOut: 5,
      reasoningTokens: 0,
      finishReason: "stop",
    }));

    await runProject({
      store,
      backend,
      config: config(),
      emit: collect().emit,
      signal: new AbortController().signal,
    });

    expect(await store.candidateReport("k1")).toMatchObject({
      candidates: [{
        source: "Rivendell", approval: "pending", occurrences: 1,
        context: "They reached Rivendell.",
      }],
    });
    expect(await store.terms()).toEqual([]);
  });

  // Production break: either auto-accept guard is ignored, or translation writes no progress/result.
  it("walks both automatic gates, translates, and hands composition off", async () => {
    const store = new FakeStore([unit(1)]);
    const { seen, emit } = collect();

    const summary = await runProject({
      store,
      backend: scriptedBackend(),
      config: config({ autoAcceptTerms: true, autoAcceptExclusions: true }),
      emit,
      signal: new AbortController().signal,
    });

    expect(seen.filter((message) => message.type === "gate")).toEqual([]);
    expect(seen).toContainEqual({ type: "progress", phase: "translate", done: 1, total: 1 });
    expect(seen).toContainEqual({ type: "phase", phase: "compose" });
    expect(seen.filter((message) => message.type === "transition")).toEqual([
      { type: "transition", event: "TERMS_READY" },
      { type: "transition", event: "CODE_INDEXED" },
      { type: "transition", event: "TRANSLATED" },
    ]);
    expect((await store.translations("k1")).get("c1.xhtml#1")?.text).toBe("Frase 1");
    expect(summary.units).toEqual({ total: 1, translated: 1, fellBack: 0, identical: 0 });
  });

  // Production break: orchestration omits the exclusions gate after code indexing.
  it("returns at the code gate before translation", async () => {
    const store = new FakeStore([unit(1)]);
    const backend = scriptedBackend();
    const { seen, emit } = collect();

    await runProject({
      store,
      backend,
      config: config({ autoAcceptTerms: true }),
      emit,
      signal: new AbortController().signal,
    });

    expect(seen).toContainEqual({ type: "gate", gate: "code" });
    expect(backend.prompts).toHaveLength(2);
    expect(backend.prompts.some((prompt) => prompt.includes("UNITS"))).toBe(false);
  });

  // Production break: the orchestrator forgets to pass the held cache set into translation planning.
  it("does not ask the model again for a cached unit", async () => {
    const store = new FakeStore([unit(1)]);
    await store.putTranslation({
      unitId: "c1.xhtml#1",
      text: "Frase 1",
      cacheKey: "k1",
      attempts: 1,
      outcome: "translated",
    });
    const backend = scriptedBackend();

    await runProject({
      store,
      backend,
      config: config({ autoAcceptTerms: true, autoAcceptExclusions: true }),
      emit: collect().emit,
      signal: new AbortController().signal,
    });

    expect(backend.prompts.some((prompt) => prompt.includes("[u:c1.xhtml#1]"))).toBe(false);
  });

  // Production break: a persisted zero-change code index is invisible and the model is paid again.
  it("reuses a durable zero-change code index on a fresh actor", async () => {
    const store = new FakeStore([unit(1)]);
    await store.putCandidateReport("k1", {
      candidates: [], open: [], discarded: 0, abstained: false,
    });
    await store.commitCodeIndex({ marked: [], freed: [], abstained: 0, sourceHash: "k1" });
    const backend = scriptedBackend();

    await runProject({
      store,
      backend,
      config: config({ autoAcceptTerms: true, autoAcceptExclusions: true }),
      emit: collect().emit,
      signal: new AbortController().signal,
    });

    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]).toContain("UNITS 1");
  });

  // Production break: malformed code verdict batches are checkpointed without a degradation declaration.
  it("records code-index abstention so composition becomes incomplete", async () => {
    const db = database();
    insertProject(db);
    db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
    db.prepare(`
      INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, kind,
                        range_start, range_end, state, source_text, raw_text)
      VALUES ('u1','p1','d1',1,'c1.xhtml#1','block',0,10,'translate','Sentence 1','Sentence 1')
    `).run();
    db.prepare("INSERT INTO run (id, project_id, phase, started_at) VALUES ('r1','p1','run','2026-08-24')").run();
    const store = new SqliteProjectStore(db, "p1", "r1");
    const backend = new FakeBackend((call) => {
      if (call.prompt.includes("TERMS")) {
        return { text: "TERMS 0\nEND", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" };
      }
      if (call.prompt.includes("VERDICTS")) {
        return { text: "malformed", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" };
      }
      return {
        text: "UNITS 1\n[u:c1.xhtml#1]\nFrase 1\nEND",
        tokensIn: 1,
        tokensOut: 1,
        reasoningTokens: 0,
        finishReason: "stop",
      };
    });

    await runProject({
      store,
      backend,
      config: config({ autoAcceptTerms: true, autoAcceptExclusions: true }),
      emit: collect().emit,
      signal: new AbortController().signal,
    });
    db.prepare("UPDATE project SET state = 'composing', machine_snapshot = NULL WHERE id = 'p1'").run();
    const host = makeMachineHost(db, "p1", { hasLanguage: true });
    expect(host.send({ type: "COMPOSED" })).toBe(true);

    expect((db.prepare("SELECT state FROM project WHERE id='p1'").get() as { state: string }).state)
      .toBe("incomplete");
    expect((db.prepare(`
      SELECT count(*) AS total FROM run_event
       WHERE run_id='r1' AND code='code-index-abstained' AND severity='degradation'
    `).get() as { total: number }).total).toBe(1);
  });

  // Production break: resume discards the persisted waiting-code snapshot and re-spends on completed phases.
  it("resumes from a persisted gate without rerunning a completed phase", async () => {
    const actor = createProjectActor({
      hasLanguage: true,
      autoAcceptTerms: true,
      autoAcceptExclusions: false,
    }).start();
    actor.send({ type: "START" });
    actor.send({ type: "TERMS_READY" });
    actor.send({ type: "CODE_INDEXED" });
    const backend = scriptedBackend();
    const { seen, emit } = collect();

    await runProject({
      store: new FakeStore([unit(1)]),
      backend,
      config: config({ autoAcceptTerms: true }),
      machineSnapshot: actor.getPersistedSnapshot(),
      emit,
      signal: new AbortController().signal,
    });

    expect(seen).toContainEqual({ type: "gate", gate: "code" });
    expect(backend.prompts).toEqual([]);
  });

  // Production break: fallback is stored but its degradation event or summary count is dropped.
  it("declares a fallback as a degradation and returns an incomplete summary", async () => {
    const store = new FakeStore([unit(1)]);
    const backend = new FakeBackend((call) => {
      if (call.prompt.includes("TERMS")) {
        return { text: "TERMS 0\nEND", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" };
      }
      if (call.prompt.includes("VERDICTS")) {
        return {
          text: "VERDICTS 1\n[v:c1.xhtml#1] prose\nEND",
          tokensIn: 1,
          tokensOut: 1,
          reasoningTokens: 0,
          finishReason: "stop",
        };
      }
      return {
        text: "UNITS 1\n[u:c1.xhtml#1]\n\nEND",
        tokensIn: 1,
        tokensOut: 1,
        reasoningTokens: 0,
        finishReason: "stop",
      };
    });

    const summary = await runProject({
      store,
      backend,
      config: config({ autoAcceptTerms: true, autoAcceptExclusions: true }),
      emit: collect().emit,
      signal: new AbortController().signal,
    });

    expect(summary.units.fellBack).toBe(1);
    expect(store.events).toContainEqual(expect.objectContaining({
      code: "unit-fell-back",
      severity: "degradation",
    }));
  });

  // Production break: Task 8's runner adapter bypasses orchestration or loses its engine-owned signal/store.
  it("exposes an EngineRunner factory over the Task 5 seam", async () => {
    const store = new FakeStore([unit(1)]);
    const seen: EngineMessage[] = [];
    const signal = new AbortController().signal;
    const runner = makeEngineRunner({ backend: scriptedBackend() });

    await runner({
      projectId: "p1", config: config(), backendSpec: { kind: "fake" },
      store, signal, emit: (message) => seen.push(message),
    });

    expect(seen).toContainEqual({ type: "gate", gate: "terms" });
    expect((await store.translations("k1")).size).toBe(0);
  });
});

describe("persisted project machine", () => {
  // Production break: an accepted event updates only the denormalized state, or only the XState snapshot.
  it("persists every accepted transition as one matching state/snapshot pair", () => {
    const db = database();
    insertProject(db);
    const host = makeMachineHost(db, "p1", {
      hasLanguage: true,
      autoAcceptTerms: false,
      autoAcceptExclusions: false,
    });

    expect(host.send({ type: "START" })).toBe(true);
    expect(host.send({ type: "TERMS_READY" })).toBe(true);

    const row = db.prepare(
      "SELECT state, machine_snapshot FROM project WHERE id='p1'",
    ).get() as { state: string; machine_snapshot: string };
    const snapshot = JSON.parse(row.machine_snapshot) as { value: string };
    expect(row.state).toBe("waiting-terms");
    expect(snapshot.value).toBe("waiting-terms");
  });

  // Production break: a refused event overwrites the last lawful persisted snapshot.
  it("does not persist an event the machine refuses", () => {
    const db = database();
    insertProject(db);
    const host = makeMachineHost(db, "p1", { hasLanguage: true });
    expect(host.send({ type: "START" })).toBe(true);
    const before = db.prepare(
      "SELECT state, machine_snapshot FROM project WHERE id='p1'",
    ).get() as { state: string; machine_snapshot: string };

    expect(host.send({ type: "RESUME" })).toBe(false);

    const after = db.prepare(
      "SELECT state, machine_snapshot FROM project WHERE id='p1'",
    ).get() as { state: string; machine_snapshot: string };
    expect(after).toEqual(before);
  });

  // Production break: rehydration treats the denormalized library index as truth over the stored XState snapshot.
  it("rehydrates from the machine snapshot when the denormalized state is stale", () => {
    const db = database();
    insertProject(db);
    const first = makeMachineHost(db, "p1", { hasLanguage: true });
    expect(first.send({ type: "START" })).toBe(true);
    db.prepare("UPDATE project SET state = 'paused' WHERE id = 'p1'").run();

    const restored = makeMachineHost(db, "p1");

    expect(restored.state).toBe("running");
  });

  // Production break: completion considers only the translation summary and ignores persisted run degradations.
  it("ends incomplete when this project's run events contain a degradation", () => {
    const db = database();
    insertProject(db, "composing");
    db.prepare(
      "INSERT INTO run (id, project_id, phase, started_at) VALUES ('r1','p1','compose','2026-08-24')",
    ).run();
    db.prepare(`
      INSERT INTO run_event (id, run_id, at, code, severity, payload_json)
      VALUES ('e1','r1','2026-08-24','unit-fell-back','degradation','{}')
    `).run();
    const host = makeMachineHost(db, "p1", { hasLanguage: true });

    expect(host.send({ type: "COMPOSED" })).toBe(true);

    const row = db.prepare("SELECT state FROM project WHERE id='p1'").get() as { state: string };
    expect(row.state).toBe("incomplete");
  });
});

describe("what the machine allows", () => {
  it("offers exactly the events the machine would accept, in each state", () => {
    const db = database();
    insertProject(db);

    // Asked of the machine, not re-derived from the state name: a condition
    // rewritten in a template diverges the day the machine changes, and
    // nothing fails until a user presses the button.
    expect(makeMachineHost(db, "p1", { hasLanguage: true }).allows).toContain("START");

    db.prepare("UPDATE project SET state = 'paused', machine_snapshot = NULL WHERE id = 'p1'").run();
    const paused = makeMachineHost(db, "p1", { hasLanguage: true }).allows;
    expect(paused).toContain("RESUME");
    expect(paused).not.toContain("PAUSE");
  });

  it("never offers an event the machine refuses, and never hides one it accepts", () => {
    // A fresh database per event: `send` persists, so reusing one would only
    // ever check the events up to the first accepted one.
    for (const state of ["ready", "running", "paused", "waiting-terms", "waiting-code"]) {
      for (const type of USER_EVENTS) {
        const db = database();
        insertProject(db, state);
        const offered = makeMachineHost(db, "p1", { hasLanguage: true }).allows.includes(type);
        const accepted = makeMachineHost(db, "p1", { hasLanguage: true }).send({ type } as never);

        // The two have to agree, or the interface promises something the
        // machine will silently drop — a button that does nothing.
        expect({ state, type, offered }).toEqual({ state, type, offered: accepted });
      }
    }
  });

  it("offers nothing that reports work nobody did", () => {
    const db = database();
    insertProject(db);

    expect(USER_EVENTS as readonly string[]).not.toContain("TRANSLATED");
    expect(USER_EVENTS as readonly string[]).not.toContain("COMPOSED");
    expect(USER_EVENTS as readonly string[]).not.toContain("FAIL");
  });
});

describe("restoreRunningProjects", () => {
  // Production break: startup recreates/resumes work instead of durably pausing it without model calls.
  it("moves running projects to paused and updates their persisted snapshots", () => {
    const db = database();
    insertProject(db, "running");

    expect(restoreRunningProjects(db)).toEqual(["p1"]);

    const row = db.prepare(
      "SELECT state, machine_snapshot FROM project WHERE id='p1'",
    ).get() as { state: string; machine_snapshot: string };
    expect(row.state).toBe("paused");
    expect((JSON.parse(row.machine_snapshot) as { value: string }).value).toBe("paused");
  });

  // Production break: recovery filters on a stale paused column and misses an authoritative running snapshot.
  it("pauses a snapshot-running project even when its denormalized state is stale", () => {
    const db = database();
    insertProject(db);
    const host = makeMachineHost(db, "p1", { hasLanguage: true });
    expect(host.send({ type: "START" })).toBe(true);
    db.prepare("UPDATE project SET state = 'paused' WHERE id='p1'").run();

    expect(restoreRunningProjects(db)).toEqual(["p1"]);

    const row = db.prepare("SELECT state, machine_snapshot FROM project WHERE id='p1'").get() as {
      state: string; machine_snapshot: string;
    };
    expect(row.state).toBe("paused");
    expect((JSON.parse(row.machine_snapshot) as { value: string }).value).toBe("paused");
  });
});
