import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective, TranslocoService } from "@jsverse/transloco";
import type { GlossaryView, TermRow, TermRule } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { Detail } from "../detail";
import { GAP, pageItems, type PageItem } from "../pages";

/** What the user has changed about a term but not yet saved. */
interface Edit {
  target?: string | null;
  rule?: TermRule;
  approval?: "approved" | "rejected";
}

/** The states the filter offers, in the order it offers them. */
const APPROVALS = ["pending", "approved", "rejected"] as const;

/** Term, rendering, state, and what can be done about it. */
const COLUMNS = "minmax(0, 1.1fr) minmax(0, 1.4fr) 7rem minmax(0, 12rem)";

const PAGE_SIZES = [10, 20, 30] as const;

/**
 * The terms gate.
 *
 * Two rules shape it. Decisions go in one call, because approving forty terms
 * is one decision about a screenful and forty transactions would leave the
 * gate half-answered if one failed in the middle. And any change that would
 * throw away existing translations shows what it costs first: the prototype
 * discarded the whole session at every change of configuration, and the price
 * of that arrived on the invoice.
 */
@Component({
  selector: "bb-terms",
  standalone: true,
  imports: [Detail, FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./terms.html",
  styleUrls: ["../list.css", "./terms.css"],
})
export class Terms implements OnDestroy {
  readonly projectId = input.required<string>();
  readonly approvals = APPROVALS;
  readonly columns = COLUMNS;
  readonly pageSizes = PAGE_SIZES;
  readonly gap = GAP;

  readonly terms = signal<TermRow[]>([]);
  readonly glossaries = signal<GlossaryView[]>([]);
  readonly edits = signal<Record<string, Edit>>({});
  readonly saving = signal(false);
  readonly failure = signal<string | null>(null);

  /** What a staged change would undo, asked before it is applied. */
  readonly invalidation = signal<
    { units: string[]; cost: { tokensIn: number; tokensOut: number } | null } | null
  >(null);

  readonly pending = computed(() => this.terms().filter((term) => term.approval === "pending"));
  readonly decided = computed(() => Object.keys(this.edits()).length);

  readonly approval = signal("");
  readonly query = signal("");
  readonly pageSize = signal<number>(20);
  readonly page = signal(1);
  /** The term being read in full, if any: one at a time, like a form. */
  readonly open = signal<string | null>(null);
  readonly opened = computed(() =>
    this.terms().find((term) => term.id === this.open()) ?? null);

  /**
   * The rows the filter and the search leave, judged on what the row shows —
   * `view`, not the stored term — so a term approved a moment ago leaves the
   * "to decide" list the moment it is decided, and not at the next save.
   */
  readonly visible = computed(() => {
    const approval = this.approval();
    const query = this.query().trim().toLowerCase();
    return this.terms().filter((term) => {
      const shown = this.view(term);
      if (approval !== "" && shown.approval !== approval) return false;
      if (query === "") return true;
      return `${term.source} ${shown.target ?? ""} ${term.context ?? ""}`
        .toLowerCase().includes(query);
    });
  });

  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.visible().length / this.pageSize())));
  readonly rows = computed(() => {
    const from = (Math.min(this.page(), this.pageCount()) - 1) * this.pageSize();
    return this.visible().slice(from, from + this.pageSize());
  });
  readonly pages = computed<PageItem[]>(() => pageItems(this.page(), this.pageCount()));
  readonly narrowed = computed(() => this.approval() !== "" || this.query() !== "");

  #ipc = inject(IpcService);
  #off: Array<() => void> = [];
  #transloco = inject(TranslocoService);

  constructor() {
    // The input arrives after construction, so the load is an effect on it
    // rather than something the constructor does once with an empty id.
    effect(() => {
      const id = this.projectId();
      if (id !== "") void this.reload(id);
    });

    // The candidates arrive when the extraction ends, and the gate may already be
    // on screen: without this it stays empty over a book that has terms.
    this.#off.push(this.#ipc.on("project.changed", (changed) => {
      if (changed.id === this.projectId()) void this.reload();
    }));
  }

  ngOnDestroy(): void {
    for (const off of this.#off) off();
  }

  async reload(projectId = this.projectId()): Promise<void> {
    const [terms, glossaries] = await Promise.all([
      this.#ipc.invoke("terms.list", { projectId }),
      this.#ipc.invoke("glossaries.list", undefined),
    ]);
    this.terms.set(terms);
    this.glossaries.set(glossaries);
  }

  /** What a row shows: the stored term with whatever the user changed on top. */
  view(term: TermRow): TermRow & { approval: TermRow["approval"] } {
    const edit = this.edits()[term.id];
    if (edit === undefined) return term;
    return {
      ...term,
      ...(edit.target === undefined ? {} : { target: edit.target }),
      ...(edit.rule === undefined ? {} : { rule: edit.rule }),
      ...(edit.approval === undefined ? {} : { approval: edit.approval }),
    };
  }

  stage(id: string, edit: Edit): void {
    this.edits.update((all) => ({ ...all, [id]: { ...all[id], ...edit } }));
  }

  decide(id: string, approval: "approved" | "rejected"): void {
    this.stage(id, { approval });
  }

  /**
   * Changes a rendering, and asks what that would undo.
   *
   * Only for a term that was already approved: an edit to something still
   * pending cannot invalidate anything, because nothing was translated under
   * it yet, and asking would be a question with a known answer.
   */
  async edit(id: string, patch: { target?: string | null; rule?: TermRule }): Promise<void> {
    this.stage(id, patch);

    const term = this.terms().find((row) => row.id === id);
    if (term === undefined || term.approval !== "approved") return;

    const preview = await this.#ipc.invoke("terms.previewInvalidation", {
      projectId: this.projectId(), termIds: [id],
    });
    this.invalidation.set(preview.units.length === 0 ? null : preview);
  }

  dismiss(): void {
    this.invalidation.set(null);
  }

  /** What the row says the term becomes: a rule, or the rendering it asks for. */
  rendering(term: TermRow): string {
    const shown = this.view(term);
    if (shown.rule === "dnt") return this.#transloco.translate("terms.rules.dnt");
    return shown.target ?? "—";
  }

  toggle(id: string): void {
    this.open.update((current) => (current === id ? null : id));
  }

  onApproval(approval: string): void {
    this.page.set(1);
    this.approval.set(approval);
  }

  onQuery(query: string): void {
    this.page.set(1);
    this.query.set(query);
  }

  goto(page: number): void {
    this.page.set(Math.min(Math.max(1, page), this.pageCount()));
  }

  onPageSize(size: number): void {
    const first = (this.page() - 1) * this.pageSize();
    this.pageSize.set(size);
    this.page.set(Math.floor(first / size) + 1);
  }

  /** Which rows of how many, in the reader's own figures. */
  range(): string {
    const total = this.visible().length;
    const from = total === 0 ? 0 : (Math.min(this.page(), this.pageCount()) - 1) * this.pageSize() + 1;
    return this.#transloco.translate("list.range", {
      from, to: Math.min(from + this.rows().length - 1, total), total,
    });
  }

  /** Approves everything still pending, in one call. */
  async approveAll(): Promise<void> {
    const decisions = this.pending().map((term) => ({ id: term.id, approval: "approved" as const }));
    if (decisions.length === 0) return;
    await this.send(decisions);
  }

  async save(): Promise<void> {
    const staged = this.edits();
    const decisions = Object.entries(staged)
      .map(([id, edit]) => ({
        id,
        approval: edit.approval ?? "approved" as const,
        ...(edit.target === undefined ? {} : { target: edit.target }),
        ...(edit.rule === undefined ? {} : { rule: edit.rule }),
      }));
    if (decisions.length === 0) return;
    await this.send(decisions);
  }

  async send(decisions: Array<{
    id: string; approval: "approved" | "rejected"; target?: string | null; rule?: TermRule;
  }>): Promise<void> {
    this.saving.set(true);
    this.failure.set(null);
    try {
      // One call. Forty separate transactions leave the gate half-answered
      // when one of them fails, and nothing downstream can tell that apart
      // from a user who approved exactly those and no others.
      await this.#ipc.invoke("terms.decide", { projectId: this.projectId(), decisions });

      const affected = this.invalidation();
      if (affected !== null) {
        await this.#ipc.invoke("terms.invalidate", {
          projectId: this.projectId(), unitIds: affected.units,
        });
        this.invalidation.set(null);
      }
      this.edits.set({});
      await this.reload();
    } catch (error) {
      this.failure.set((error as { code?: string }).code ?? "unknown");
    } finally {
      this.saving.set(false);
    }
  }

  /** Unblocks the machine. Separate from saving: deciding is not committing. */
  async approveGate(): Promise<void> {
    await this.save();
    await this.#ipc.invoke("run.approve", { projectId: this.projectId(), gate: "terms" });
  }

  async promote(id: string, glossaryId: string): Promise<void> {
    if (glossaryId === "") return;
    this.failure.set(null);
    try {
      await this.#ipc.invoke("terms.promote", { termId: id, glossaryId });
    } catch (error) {
      this.failure.set((error as { code?: string }).code ?? "unknown");
    }
  }
}
