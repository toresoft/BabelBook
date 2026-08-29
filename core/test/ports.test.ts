import { describe, expect, it } from "vitest";
import { runProjectStoreContract } from "./contract/project-store.ts";
import { FakeStore } from "./fake/store.ts";
import { FakeBackend } from "./fake/backend.ts";

runProjectStoreContract("FakeStore", async (units) => new FakeStore(units));

describe("fakes", () => {
  it("stores and returns a translation under its cache key", async () => {
    const store = new FakeStore();
    await store.putTranslation({
      unitId: "c1.xhtml#1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated",
    });
    expect((await store.translations("k1")).get("c1.xhtml#1")?.text).toBe("Uno");
    expect((await store.translations("k2")).size).toBe(0);
  });

  it("replays scripted answers and records what it was asked", async () => {
    const backend = new FakeBackend(["first", "second"]);
    expect((await backend.call({ prompt: "a" })).text).toBe("first");
    expect((await backend.call({ prompt: "b" })).text).toBe("second");
    expect(backend.prompts).toEqual(["a", "b"]);
  });

  it("refuses to answer more times than it was scripted", async () => {
    const backend = new FakeBackend(["only"]);
    await backend.call({ prompt: "a" });
    await expect(backend.call({ prompt: "b" })).rejects.toThrow();
  });

  it("answers from a function when the reply depends on the prompt", async () => {
    const backend = new FakeBackend((call) => ({
      text: call.prompt.includes("UNITS") ? "UNITS 0\nEND" : "en",
      tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
    }));
    expect((await backend.call({ prompt: "UNITS 1" })).text).toBe("UNITS 0\nEND");
    expect((await backend.call({ prompt: "which language" })).text).toBe("en");
  });

  it("keeps the units it was seeded with, and filters them by state", async () => {
    const store = new FakeStore([
      { id: "c1.xhtml#1", kind: "block", doc: "c1.xhtml", ordinal: 1, range: [0, 3],
        source: "One", raw: "One", state: "translate" },
      { id: "c1.xhtml#2", kind: "block", doc: "c1.xhtml", ordinal: 2, range: [4, 9],
        source: "x = 1", raw: "x = 1", state: "code" },
    ]);
    expect((await store.units()).length).toBe(2);
    expect((await store.units({ states: ["translate"] })).map((u) => u.id)).toEqual(["c1.xhtml#1"]);
  });

  it("records events in the order they happened", async () => {
    const store = new FakeStore();
    await store.event({ code: "unit-fell-back", severity: "degradation", payload: { unitId: "c1.xhtml#1" } });
    expect(store.events.map((e) => e.code)).toEqual(["unit-fell-back"]);
  });
});
