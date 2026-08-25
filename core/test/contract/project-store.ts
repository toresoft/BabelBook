import { describe, expect, it } from "vitest";
import type { ProjectStore } from "../../ports.ts";
import type { TranslationUnit } from "../../epub/index.ts";

/**
 * One contract, every implementation.
 *
 * The in-memory fake and the SQLite store must be interchangeable, or the
 * engine's tests prove something about an object that never runs in
 * production. So the battery lives here, in the core, and both sides import
 * it: a divergence fails a test instead of surfacing as a bug months later.
 */
export function runProjectStoreContract(
  name: string,
  make: (units: TranslationUnit[]) => Promise<ProjectStore>,
): void {
  const unit = (
    ordinal: number,
    source: string,
    state: TranslationUnit["state"] = "translate",
    doc = "c1.xhtml",
  ): TranslationUnit => ({
    id: `${doc}#${ordinal}`,
    kind: "block",
    doc,
    ordinal,
    range: [ordinal * 100, ordinal * 100 + source.length],
    source,
    raw: source,
    state,
  });

  const stored = (unitId: string, text: string, cacheKey = "k1") => ({
    unitId, text, cacheKey, attempts: 1, outcome: "translated" as const,
  });

  describe(`${name} (ProjectStore contract)`, () => {
    it("returns a translation under its own cache key, and under no other", async () => {
      const store = await make([unit(1, "One")]);
      await store.putTranslation(stored("c1.xhtml#1", "Uno"));

      expect((await store.translations("k1")).get("c1.xhtml#1")?.text).toBe("Uno");
      expect((await store.translations("k2")).size).toBe(0);
    });

    it("replaces a translation retried under the same key instead of keeping both", async () => {
      const store = await make([unit(1, "One")]);
      await store.putTranslation(stored("c1.xhtml#1", "Uno"));
      await store.putTranslation({ ...stored("c1.xhtml#1", "Uno corretto"), attempts: 2 });

      const held = await store.translations("k1");
      expect(held.size).toBe(1);
      expect(held.get("c1.xhtml#1")).toMatchObject({ text: "Uno corretto", attempts: 2 });
    });

    it("keeps the same unit's work under two keys apart", async () => {
      const store = await make([unit(1, "One")]);
      await store.putTranslation(stored("c1.xhtml#1", "Uno", "k1"));
      await store.putTranslation(stored("c1.xhtml#1", "Autre", "k2"));

      expect((await store.translations("k1")).get("c1.xhtml#1")?.text).toBe("Uno");
      expect((await store.translations("k2")).get("c1.xhtml#1")?.text).toBe("Autre");
    });

    it("filters units by state, and by document", async () => {
      const store = await make([
        unit(1, "One"),
        unit(2, "x = 1", "code"),
        unit(1, "Two", "translate", "c2.xhtml"),
      ]);

      expect((await store.units()).length).toBe(3);
      expect((await store.units({ states: ["translate"] })).map((u) => u.id))
        .toEqual(["c1.xhtml#1", "c2.xhtml#1"]);
      expect((await store.units({ doc: "c2.xhtml" })).map((u) => u.id)).toEqual(["c2.xhtml#1"]);
    });

    it("returns units carrying the fields the engine reads", async () => {
      const store = await make([unit(1, "One")]);
      const [only] = await store.units();

      expect(only).toMatchObject({
        id: "c1.xhtml#1", doc: "c1.xhtml", ordinal: 1, kind: "block",
        source: "One", state: "translate",
      });
      expect(only.range).toEqual([100, 103]);
    });

    it("changes a unit's state, with the reason that caused it", async () => {
      const store = await make([unit(1, "npm install foo")]);
      await store.putUnitState("c1.xhtml#1", "maybe-code", "model-verdict");

      const [only] = await store.units();
      expect(only).toMatchObject({ state: "maybe-code", reason: "model-verdict" });
      expect((await store.units({ states: ["translate"] })).length).toBe(0);
    });

    it("writes terms and reads them back", async () => {
      const store = await make([]);
      await store.putTerms([
        { source: "Rivendell", rule: "dnt", origin: "extracted" },
        { source: "dwarf", target: "nano", rule: "must", origin: "glossary" },
      ]);

      const read = await store.terms();
      expect(read).toHaveLength(2);
      expect(read.find((t) => t.source === "dwarf")).toMatchObject({ target: "nano", rule: "must" });
    });

    it("upserts a term by its source rather than doubling it", async () => {
      const store = await make([]);
      await store.putTerms([{ source: "dwarf", target: "nano", rule: "must", origin: "extracted" }]);
      await store.putTerms([{ source: "dwarf", target: "nanerottolo", rule: "must", origin: "manual" }]);

      const read = await store.terms();
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({ target: "nanerottolo", origin: "manual" });
    });

    it("accepts an event of every severity, payload and all", async () => {
      const store = await make([unit(1, "One")]);

      // Nothing in the port reads events back — the report does, over SQL —
      // so what the contract can assert is that writing one is accepted.
      // That is not nothing: it is what catches a store wired to a schema
      // that refuses the row, which is how this test earned its place.
      await expect(store.event({
        code: "unit-fell-back",
        severity: "degradation",
        payload: { unitId: "c1.xhtml#1", reason: "exhausted" },
      })).resolves.toBeUndefined();

      await expect(store.event({ code: "author-translate-no", severity: "info", payload: {} }))
        .resolves.toBeUndefined();
    });
  });
}
