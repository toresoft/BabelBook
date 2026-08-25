import type { ProjectStore, RunEvent, StoredTranslation, UnitFilter } from "../../ports.ts";
import type { TranslationUnit, UnitState } from "../../epub/index.ts";
import type { TermEntry } from "../../glossary/types.ts";

/** A `ProjectStore` that keeps everything in memory, for tests that must not touch a database. */
export class FakeStore implements ProjectStore {
  readonly events: RunEvent[] = [];

  #units: TranslationUnit[];
  #translations = new Map<string, Map<string, StoredTranslation>>();
  #terms: TermEntry[] = [];

  constructor(units: TranslationUnit[] = []) {
    this.#units = [...units];
  }

  async units(filter?: UnitFilter): Promise<TranslationUnit[]> {
    return this.#units.filter((unit) =>
      (filter?.states === undefined || filter.states.includes(unit.state))
      && (filter?.doc === undefined || unit.doc === filter.doc));
  }

  async putUnitState(unitId: string, state: UnitState, reason?: string): Promise<void> {
    this.#units = this.#units.map((unit) =>
      unit.id === unitId ? { ...unit, state, ...(reason === undefined ? {} : { reason }) } : unit);
  }

  async translations(cacheKey: string): Promise<Map<string, StoredTranslation>> {
    return new Map(this.#translations.get(cacheKey) ?? []);
  }

  async putTranslation(translation: StoredTranslation): Promise<void> {
    const forKey = this.#translations.get(translation.cacheKey) ?? new Map<string, StoredTranslation>();
    forKey.set(translation.unitId, translation);
    this.#translations.set(translation.cacheKey, forKey);
  }

  async terms(): Promise<TermEntry[]> {
    return [...this.#terms];
  }

  /** Upsert by source: the same term written twice is one term, not two. */
  async putTerms(terms: TermEntry[]): Promise<void> {
    for (const term of terms) {
      const at = this.#terms.findIndex((held) => held.source === term.source);
      if (at === -1) this.#terms.push(term);
      else this.#terms[at] = term;
    }
  }

  async event(event: RunEvent): Promise<void> {
    this.events.push(event);
  }
}
