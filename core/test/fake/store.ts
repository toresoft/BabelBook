import type { ProjectStore, RunEvent, StoredTranslation, UnitFilter } from "../../ports.ts";
import type { TranslationUnit, UnitState } from "../../epub/index.ts";
import type { TermEntry } from "../../glossary/types.ts";
import type { CandidateReport } from "../../analyze/candidates.ts";
import type { CodeIndex } from "../../analyze/code.ts";

/** A `ProjectStore` that keeps everything in memory, for tests that must not touch a database. */
export class FakeStore implements ProjectStore {
  readonly events: RunEvent[] = [];

  #units: TranslationUnit[];
  #translations = new Map<string, Map<string, StoredTranslation>>();
  #terms: TermEntry[] = [];
  #candidateReports = new Map<string, CandidateReport>();
  #codeIndexes = new Map<string, CodeIndex>();

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

  async candidateReport(cacheKey: string): Promise<CandidateReport | null> {
    const report = this.#candidateReports.get(cacheKey);
    return report === undefined ? null : structuredClone(report);
  }

  async putCandidateReport(cacheKey: string, report: CandidateReport): Promise<void> {
    this.#candidateReports.set(cacheKey, structuredClone(report));
  }

  async codeIndex(sourceHash: string): Promise<CodeIndex | null> {
    const index = this.#codeIndexes.get(sourceHash);
    return index === undefined ? null : structuredClone(index);
  }

  async commitCodeIndex(index: CodeIndex): Promise<void> {
    const held = new Set(this.#units.map((unit) => unit.id));
    const missing = [...index.marked, ...index.freed].find((unitId) => !held.has(unitId));
    if (missing !== undefined) throw new Error(`unit not found: ${missing}`);

    for (const unitId of index.marked) {
      await this.putUnitState(unitId, "maybe-code", "model-code-suspected");
    }
    for (const unitId of index.freed) {
      await this.putUnitState(unitId, "translate");
    }
    this.#codeIndexes.set(index.sourceHash, structuredClone(index));
    if (index.abstained > 0) {
      this.events.push({
        code: "code-index-abstained",
        severity: "degradation",
        payload: { batches: index.abstained },
      });
    }
  }

  async event(event: RunEvent): Promise<void> {
    this.events.push(event);
  }
}
