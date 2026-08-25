import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ProjectStore, RunEvent, StoredTranslation, UnitFilter,
} from "../../../core/ports.ts";
import type { TermEntry } from "../../../core/glossary/types.ts";
import type { Placeholder, TranslationUnit, UnitState } from "../../../core/epub/index.ts";

interface UnitRow {
  id: string;
  unit_id: string;
  doc: string;
  ordinal: number;
  kind: string;
  range_start: number;
  range_end: number;
  state: string;
  source_text: string;
  placeholders: string | null;
  raw_text: string | null;
  reason: string | null;
  owner_unit_id: string | null;
}

/**
 * `ProjectStore` over the application database.
 *
 * Two identifiers meet here and must not be confused: `unit.id` is the row's
 * primary key, while `unit.unit_id` is `{doc}#{ordinal}`, the identity the
 * engine works with and the one the port speaks. Every method translates
 * between them, and nothing outside this file needs to know there are two.
 */
export class SqliteProjectStore implements ProjectStore {
  #db: DatabaseSync;
  #projectId: string;
  #runId: string | null;

  /**
   * `runId` is required to record events: `run_event.run_id` is NOT NULL, and
   * an event with no run is a degradation nobody can attribute to a book. A
   * store built without one still reads and writes translations — that is the
   * shape ingestion needs, before any run exists.
   */
  constructor(db: DatabaseSync, projectId: string, runId: string | null = null) {
    this.#db = db;
    this.#projectId = projectId;
    this.#runId = runId;
  }

  async units(filter?: UnitFilter): Promise<TranslationUnit[]> {
    const rows = this.#db.prepare(`
      SELECT u.id, u.unit_id, d.zip_path AS doc, u.ordinal, u.kind,
             u.range_start, u.range_end,
             coalesce(u.forced_state, u.state) AS state,
             u.source_text, u.raw_text, u.placeholders, u.reason, u.owner_unit_id
        FROM unit u
        JOIN project_document d ON d.id = u.document_id
       WHERE u.project_id = ?
       ORDER BY d.spine_order, u.ordinal
    `).all(this.#projectId) as unknown as UnitRow[];

    return rows
      .filter((row) =>
        (filter?.states === undefined || filter.states.includes(row.state as UnitState))
        && (filter?.doc === undefined || row.doc === filter.doc))
      .map((row) => this.#toUnit(row));
  }

  /**
   * A forced state is the user's decision and outranks what we deduced, so it
   * is what `units()` reports. Writing a state never touches `forced_state`:
   * the deduction and the decision are different facts, and plan 5 must be
   * able to clear one without losing the other.
   */
  async putUnitState(unitId: string, state: UnitState, reason?: string): Promise<void> {
    const changed = this.#db.prepare(`
      UPDATE unit SET state = ?, reason = ?
       WHERE project_id = ? AND unit_id = ?
    `).run(state, reason ?? null, this.#projectId, unitId);

    if (changed.changes === 0) {
      throw new Error(`unit not found in project ${this.#projectId}: ${unitId}`);
    }
  }

  async translations(cacheKey: string): Promise<Map<string, StoredTranslation>> {
    const rows = this.#db.prepare(`
      SELECT u.unit_id AS unitId, t.text, t.cache_key AS cacheKey, t.attempts, t.outcome
        FROM translation t
        JOIN unit u ON u.id = t.unit_id
       WHERE u.project_id = ? AND t.cache_key = ?
    `).all(this.#projectId, cacheKey) as unknown as StoredTranslation[];

    return new Map(rows.map((row) => [row.unitId, row]));
  }

  /**
   * A retry replaces the attempt before it. Without the upsert the table would
   * become a log of every guess, and `translations()` would have to decide
   * which row is the truth — a decision with no right answer.
   */
  async putTranslation(translation: StoredTranslation): Promise<void> {
    const row = this.#db.prepare(
      "SELECT id FROM unit WHERE project_id = ? AND unit_id = ?",
    ).get(this.#projectId, translation.unitId) as { id: string } | undefined;

    if (row === undefined) {
      throw new Error(`unit not found in project ${this.#projectId}: ${translation.unitId}`);
    }

    this.#db.prepare(`
      INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (unit_id, cache_key) DO UPDATE
        SET text = excluded.text, attempts = excluded.attempts, outcome = excluded.outcome
    `).run(randomUUID(), row.id, translation.text, translation.cacheKey,
      translation.attempts, translation.outcome);
  }

  /**
   * Only approved terms leave this port.
   *
   * The engine applies what it is given, so handing it a pending candidate
   * would apply terminology the user never approved — silently, and to the
   * whole book.
   */
  async terms(): Promise<TermEntry[]> {
    const rows = this.#db.prepare(`
      SELECT source, target, rule, origin, sense, note
        FROM term
       WHERE project_id = ? AND approval_state = 'approved'
       ORDER BY source
    `).all(this.#projectId) as unknown as Array<{
      source: string; target: string | null; rule: string;
      origin: string | null; sense: string | null; note: string | null;
    }>;

    return rows.map((row) => ({
      source: row.source,
      ...(row.target === null ? {} : { target: row.target }),
      rule: row.rule as TermEntry["rule"],
      origin: (row.origin ?? "manual") as TermEntry["origin"],
      ...(row.sense === null ? {} : { sense: row.sense }),
      ...(row.note === null ? {} : { note: row.note }),
    }));
  }

  /** Terms handed through this port are the active ones, so they land approved. */
  async putTerms(terms: TermEntry[]): Promise<void> {
    const statement = this.#db.prepare(`
      INSERT INTO term (id, project_id, source, target, rule, origin, approval_state, sense, note)
      VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?)
      ON CONFLICT (project_id, source) DO UPDATE
        SET target = excluded.target, rule = excluded.rule,
            origin = excluded.origin, sense = excluded.sense, note = excluded.note,
            approval_state = 'approved'
    `);
    for (const term of terms) {
      statement.run(randomUUID(), this.#projectId, term.source, term.target ?? null,
        term.rule, term.origin, term.sense ?? null, term.note ?? null);
    }
  }

  async event(event: RunEvent): Promise<void> {
    if (this.#runId === null) {
      throw new Error("this store has no run: an event cannot be attributed to one");
    }
    this.#db.prepare(`
      INSERT INTO run_event (id, run_id, at, code, severity, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), this.#runId, new Date().toISOString(),
      event.code, event.severity, JSON.stringify(event.payload));
  }

  #toUnit(row: UnitRow): TranslationUnit {
    const placeholders = row.placeholders === null
      ? undefined
      : (JSON.parse(row.placeholders) as Placeholder[]);

    return {
      id: row.unit_id,
      kind: row.kind as TranslationUnit["kind"],
      doc: row.doc,
      ordinal: row.ordinal,
      range: [row.range_start, row.range_end],
      source: row.source_text,
      // Falls back to the decoded text only for a row written before
      // `raw_text` existed. A unit whose `raw` is a guess cannot be spliced
      // back byte for byte, so ingestion always writes the real bytes.
      raw: row.raw_text ?? row.source_text,
      state: row.state as UnitState,
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(placeholders === undefined ? {} : { placeholders }),
      ...(row.owner_unit_id === null ? {} : { owner: row.owner_unit_id }),
    };
  }
}
