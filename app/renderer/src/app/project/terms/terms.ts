import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective } from "@jsverse/transloco";
import type { GlossaryView, TermRow, TermRule } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";

/** What the user has changed about a term but not yet saved. */
interface Edit {
  target?: string | null;
  rule?: TermRule;
  approval?: "approved" | "rejected";
}

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
  imports: [FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./terms.html",
  styleUrl: "./terms.css",
})
export class Terms {
  readonly projectId = input.required<string>();

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

  #ipc = inject(IpcService);

  constructor() {
    // The input arrives after construction, so the load is an effect on it
    // rather than something the constructor does once with an empty id.
    effect(() => {
      const id = this.projectId();
      if (id !== "") void this.reload(id);
    });
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
