import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { startEngineRuntime } from "../engine/main.ts";
import { StoreClient, type MessagePortLike } from "../engine/store-client.ts";
import {
  configureEngineHost, isEngineMessage, makeEngineHost, startEngine, type UtilityProcessLike,
} from "../main/run/engine-host.ts";
import { makeStoreProxy } from "../main/run/store-proxy.ts";
import type { EngineCommand, StoreRequest } from "../shared/run.ts";
import { FakeStore } from "../../core/test/fake/store.ts";

class TestPort extends EventEmitter implements MessagePortLike {
  readonly sent: unknown[] = [];

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  send(message: unknown): void {
    this.emit("message", { data: message });
  }

  start(): void {}
  close(): void {}
}

class TestUtilityProcess extends EventEmitter implements UtilityProcessLike {
  readonly sent: Array<{ message: unknown; ports: MessagePortLike[] }> = [];
  killed = false;

  postMessage(message: unknown, ports: MessagePortLike[]): void {
    this.sent.push({ message, ports });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", 0);
    return true;
  }
}

const command = (projectId = "p1"): EngineCommand => ({
  type: "start",
  projectId,
  runId: "r1",
  workspaceRoot: "/w",
  config: {
    projectId, cacheKey: "k1", sourceLanguage: "en", targetLanguage: "it",
    autoAcceptTerms: false, autoAcceptExclusions: false, concurrency: 1,
  },
  backend: { kind: "fake" },
});

describe("store proxy", () => {
  // Catches a proxy that acknowledges reads without returning the store result.
  it("answers a method call over the message channel", async () => {
    const store = new FakeStore();
    await store.putTranslation({ unitId: "u1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated" });
    const sent: unknown[] = [];
    const proxy = makeStoreProxy(store, (message) => sent.push(message));

    await proxy.handle({ type: "store", id: 7, method: "translations", args: ["k1"] });

    expect(sent).toEqual([{
      type: "store-result", id: 7, ok: true,
      value: new Map([["u1", { unitId: "u1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated" }]]),
    }]);
  });

  // Catches a proxy that indexes arbitrary object properties from untrusted messages.
  it("refuses a method that is not part of the ProjectStore contract", async () => {
    const sent: unknown[] = [];
    const proxy = makeStoreProxy(new FakeStore(), (message) => sent.push(message));

    await proxy.handle({ type: "store", id: 1, method: "constructor", args: [] });

    expect(sent).toEqual([{ type: "store-result", id: 1, ok: false, code: "UNKNOWN_METHOD" }]);
  });

  // Catches a store exception escaping the process boundary instead of becoming data.
  it("returns the store failure as a code, not as an exception", async () => {
    const broken = { ...new FakeStore(), units: async () => { throw new Error("disk on fire"); } };
    const sent: unknown[] = [];
    const proxy = makeStoreProxy(broken as never, (message) => sent.push(message));

    await expect(proxy.handle({ type: "store", id: 2, method: "units", args: [] })).resolves.toBeUndefined();

    expect(sent).toEqual([{ type: "store-result", id: 2, ok: false, code: "STORE_FAILED" }]);
  });

  // Catches a proxy that drops writes because only value-returning methods were wired.
  it("executes an allowlisted write before acknowledging it", async () => {
    const store = new FakeStore();
    const sent: unknown[] = [];
    const proxy = makeStoreProxy(store, (message) => sent.push(message));

    await proxy.handle({
      type: "store", id: 3, method: "putTerms",
      args: [[{ source: "Rivendell", rule: "dnt", origin: "manual" }]],
    });

    expect(await store.terms()).toEqual([{ source: "Rivendell", rule: "dnt", origin: "manual" }]);
    expect(sent).toEqual([{ type: "store-result", id: 3, ok: true, value: undefined }]);
  });

  // Production break: new durable phase methods are omitted from the RPC allowlist/switch.
  it("carries candidate reports and code checkpoints over the store proxy", async () => {
    const store = new FakeStore([{ id: "u1", kind: "block", doc: "c1", ordinal: 1,
      range: [0, 1], source: "x", raw: "x", state: "translate" }]);
    const sent: unknown[] = [];
    const proxy = makeStoreProxy(store, (message) => sent.push(message));
    const report = { candidates: [], open: [], discarded: 0, abstained: false };

    await proxy.handle({ type: "store", id: 20, method: "putCandidateReport", args: ["k1", report] });
    await proxy.handle({ type: "store", id: 21, method: "candidateReport", args: ["k1"] });
    await proxy.handle({ type: "store", id: 22, method: "commitCodeIndex", args: [{
      marked: [], freed: [], abstained: 0, sourceHash: "k1",
    }] });
    await proxy.handle({ type: "store", id: 23, method: "codeIndex", args: ["k1"] });

    expect(sent).toEqual([
      { type: "store-result", id: 20, ok: true, value: undefined },
      { type: "store-result", id: 21, ok: true, value: report },
      { type: "store-result", id: 22, ok: true, value: undefined },
      { type: "store-result", id: 23, ok: true, value: {
        marked: [], freed: [], abstained: 0, sourceHash: "k1",
      } },
    ]);
  });
});

describe("store client", () => {
  // Catches a malformed main-process reply crashing the engine's store client before its valid reply arrives.
  it("ignores null and malformed messages before resolving a later valid response", async () => {
    const port = new TestPort();
    const store = new StoreClient(port);
    const pending = store.terms();
    const [{ id }] = port.sent as StoreRequest[];

    expect(() => port.send(null)).not.toThrow();
    expect(() => port.send({ type: "store-result", id, ok: "yes" })).not.toThrow();
    port.send({ type: "store-result", id, ok: true, value: [] });

    await expect(pending).resolves.toEqual([]);
  });

  // Catches responses resolving the wrong outstanding store call when messages arrive out of order.
  it("correlates concurrent responses by request id", async () => {
    const port = new TestPort();
    const store = new StoreClient(port);
    const terms = store.terms();
    const translations = store.translations("k1");
    const [first, second] = port.sent as StoreRequest[];

    port.send({ type: "store-result", id: second.id, ok: true, value: new Map([["u1", {
      unitId: "u1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated",
    }]]) });
    port.send({ type: "store-result", id: first.id, ok: true, value: [{ source: "Rivendell", rule: "dnt", origin: "manual" }] });

    await expect(terms).resolves.toEqual([{ source: "Rivendell", rule: "dnt", origin: "manual" }]);
    await expect(translations).resolves.toEqual(new Map([["u1", {
      unitId: "u1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated",
    }]]));
  });

  // Catches a remote store failure being silently converted to an empty successful result.
  it("rejects a call with the code returned by the main process", async () => {
    const port = new TestPort();
    const store = new StoreClient(port);
    const pending = store.units();
    const [{ id }] = port.sent as StoreRequest[];

    port.send({ type: "store-result", id, ok: false, code: "STORE_FAILED" });

    await expect(pending).rejects.toMatchObject({ code: "STORE_FAILED" });
  });

  // Catches a dead MessagePort leaving engine work awaiting a reply forever.
  it("rejects outstanding calls when the client closes", async () => {
    const port = new TestPort();
    const store = new StoreClient(port);
    const pending = store.units();

    store.close();

    await expect(pending).rejects.toMatchObject({ code: "STORE_DISCONNECTED" });
  });

  // Production break: the client implements the interface locally but emits the wrong RPC method or arguments.
  it("sends candidate and code-index durability calls through the typed RPC client", async () => {
    const port = new TestPort();
    const store = new StoreClient(port);
    const report = store.candidateReport("k1");
    const [readRequest] = port.sent as StoreRequest[];
    expect(readRequest).toMatchObject({ method: "candidateReport", args: ["k1"] });
    port.send({
      type: "store-result", id: readRequest.id, ok: true,
      value: { candidates: [], open: [], discarded: 0, abstained: false },
    });
    await expect(report).resolves.toEqual({ candidates: [], open: [], discarded: 0, abstained: false });

    port.sent.length = 0;
    const checkpoint = { marked: [], freed: [], abstained: 0, sourceHash: "k1" };
    const write = store.commitCodeIndex(checkpoint);
    const [writeRequest] = port.sent as StoreRequest[];
    expect(writeRequest).toMatchObject({ method: "commitCodeIndex", args: [checkpoint] });
    port.send({ type: "store-result", id: writeRequest.id, ok: true, value: undefined });
    await expect(write).resolves.toBeUndefined();
  });
});

describe("engine runtime", () => {
  // Catches a malformed main-process command dereferencing `.type` and killing the utility process.
  it("ignores null and malformed commands before accepting a valid start", () => {
    const port = new TestPort();
    startEngineRuntime(port);

    expect(() => port.send(null)).not.toThrow();
    expect(() => port.send({ type: "start", projectId: 3 })).not.toThrow();
    port.send(command());

    expect(port.sent).toEqual([{ type: "failed", code: "RUNNER_UNAVAILABLE" }]);
  });

  // Catches the entry point importing Task 6 orchestration instead of accepting its runner at the boundary.
  it("runs an injected command runner with an engine-owned AbortSignal", async () => {
    const port = new TestPort();
    let received: { projectId: string; signal: AbortSignal } | undefined;
    startEngineRuntime(port, async (input) => {
      received = { projectId: input.projectId, signal: input.signal };
    });

    port.send(command("p4"));
    await Promise.resolve();
    port.send({ type: "pause" });

    expect(received?.projectId).toBe("p4");
    expect(received?.signal.aborted).toBe(true);
  });

  // Catches an unavailable orchestrator being mistaken for a successful no-op start.
  it("reports that no runner has been installed yet", () => {
    const port = new TestPort();
    startEngineRuntime(port);

    port.send(command());

    expect(port.sent).toEqual([{ type: "failed", code: "RUNNER_UNAVAILABLE" }]);
  });
});

describe("engine host", () => {
  // Catches a host that uses the utility process control channel for work instead of a dedicated MessagePort.
  it("sends commands and receives events over its dedicated port", () => {
    const child = new TestUtilityProcess();
    const mainPort = new TestPort();
    const enginePort = new TestPort();
    const received: string[] = [];
    const handle = makeEngineHost({
      enginePath: "/app/engine.js",
      fork: () => child,
      makeChannel: () => ({ port1: mainPort, port2: enginePort }),
      storeFor: () => new FakeStore(),
      onCrash: async () => {},
    });
    const stop = handle.on((message) => {
      if (message.type === "phase") received.push(message.phase);
    });

    handle.send(command());
    mainPort.send({ type: "phase", phase: "translate" });
    stop();
    mainPort.send({ type: "phase", phase: "compose" });

    expect(child.sent).toEqual([{ message: { type: "connect" }, ports: [enginePort] }]);
    expect(mainPort.sent).toEqual([command()]);
    expect(received).toEqual(["translate"]);
  });

  // Catches a host that sends store RPC to no project, or to the previously active project.
  it("routes engine store calls to the project selected by start", async () => {
    const child = new TestUtilityProcess();
    const mainPort = new TestPort();
    const selected = new FakeStore();
    const handle = makeEngineHost({
      enginePath: "/app/engine.js",
      fork: () => child,
      makeChannel: () => ({ port1: mainPort, port2: new TestPort() }),
      storeFor: (projectId) => {
        if (projectId !== "p2") throw new Error(`unexpected project ${projectId}`);
        return selected;
      },
      onCrash: async () => {},
    });

    handle.send(command("p2"));
    mainPort.send({
      type: "store", id: 8, method: "putTerms",
      args: [[{ source: "Moria", rule: "dnt", origin: "manual" }]],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(await selected.terms()).toEqual([{ source: "Moria", rule: "dnt", origin: "manual" }]);
    expect(mainPort.sent.at(-1)).toEqual({ type: "store-result", id: 8, ok: true, value: undefined });
  });

  // Catches an engine crash leaving a project marked running, and catches a deliberate kill as a crash.
  it("pauses the active project after an unexpected exit but not after kill", async () => {
    const child = new TestUtilityProcess();
    const mainPort = new TestPort();
    const paused: string[] = [];
    const handle = makeEngineHost({
      enginePath: "/app/engine.js",
      fork: () => child,
      makeChannel: () => ({ port1: mainPort, port2: new TestPort() }),
      storeFor: () => new FakeStore(),
      onCrash: async (projectId) => { paused.push(projectId); },
    });

    handle.send(command());
    child.emit("exit", 1);
    await Promise.resolve();

    expect(handle.alive).toBe(false);
    expect(paused).toEqual(["p1"]);

    const deliberate = new TestUtilityProcess();
    const killed = makeEngineHost({
      enginePath: "/app/engine.js",
      fork: () => deliberate,
      makeChannel: () => ({ port1: new TestPort(), port2: new TestPort() }),
      storeFor: () => new FakeStore(),
      onCrash: async (projectId) => { paused.push(projectId); },
    });
    killed.send(command("p3"));

    await killed.kill();

    expect(deliberate.killed).toBe(true);
    expect(paused).toEqual(["p1"]);
  });

  // Catches the documented zero-argument entry point being absent or bypassing the registered production wiring.
  it("starts the production entry through its registered Electron boundary", () => {
    const child = new TestUtilityProcess();
    const mainPort = new TestPort();
    const enginePort = new TestPort();
    const reset = configureEngineHost({
      enginePath: "/app/engine.js",
      fork: () => child,
      makeChannel: () => ({ port1: mainPort, port2: enginePort }),
      storeFor: () => new FakeStore(),
      onCrash: async () => {},
    });

    try {
      const handle = startEngine();
      handle.send(command());

      expect(child.sent).toEqual([{ message: { type: "connect" }, ports: [enginePort] }]);
      expect(mainPort.sent).toEqual([command()]);
    } finally {
      reset();
    }
  });

  // Catches a malformed engine message crashing main before a later valid event can be delivered.
  it("ignores null and malformed engine messages before delivering a valid event", () => {
    const child = new TestUtilityProcess();
    const mainPort = new TestPort();
    const phases: string[] = [];
    const handle = makeEngineHost({
      enginePath: "/app/engine.js",
      fork: () => child,
      makeChannel: () => ({ port1: mainPort, port2: new TestPort() }),
      storeFor: () => new FakeStore(),
      onCrash: async () => {},
    });
    handle.on((message) => {
      if (message.type === "phase") phases.push(message.phase);
    });

    expect(() => mainPort.send(null)).not.toThrow();
    expect(() => mainPort.send({ type: "store", id: 5, method: "terms", args: "not-an-array" })).not.toThrow();
    expect(() => mainPort.send({ type: "phase" })).not.toThrow();
    mainPort.send({ type: "phase", phase: "translate" });

    expect(phases).toEqual(["translate"]);
  });
});

describe("the progress message", () => {
  it("is refused when its phase is not one the run has", () => {
    expect(isEngineMessage({ type: "progress", phase: "sorting", done: 1, total: 2 })).toBe(false);
  });

  it("is accepted with a phase the run has", () => {
    expect(isEngineMessage({ type: "progress", phase: "code-index", done: 1, total: 2 })).toBe(true);
  });

  /**
   * A phase-less progress message is the shape of the previous protocol. It is
   * refused rather than defaulted: a bar that says "translating" while the
   * code index runs is worse than a bar that says nothing, because it is
   * believed.
   */
  it("is refused without a phase", () => {
    expect(isEngineMessage({ type: "progress", done: 1, total: 2 })).toBe(false);
  });
});

/**
 * The SDK is a dependency now, not a hope.
 *
 * Importing it by name is the whole assertion: this file does not compile, and
 * this test does not run, on a checkout where `ai` is not installed. The
 * source check beside it is what keeps the two call sites from drifting back
 * to a specifier held in a variable, which typechecks on any machine and
 * therefore proves nothing.
 */
describe("the SDK the run calls", () => {
  it("is imported by name and exports generateText", () => {
    expect(typeof generateText).toBe("function");
  });

  it("is not hidden behind a variable in either process", async () => {
    for (const path of ["app/main/main.ts", "app/engine/main.ts"]) {
      expect(await readFile(path, "utf8")).not.toContain('const aiModule = "ai"');
    }
  });
});
