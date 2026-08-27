import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective } from "@jsverse/transloco";
import type { GlossaryTerm, GlossaryView, TermRule } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";

/**
 * The glossaries every future book will read.
 *
 * Editing is deliberate rather than live: a glossary's version rides in the
 * cache key, and saving after every keystroke would invalidate the
 * translations of every book that uses it, over and over, while someone was
 * still typing a word.
 */
@Component({
  selector: "bb-glossaries",
  standalone: true,
  imports: [FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./glossaries.html",
  styleUrl: "./glossaries.css",
})
export class Glossaries {
  readonly glossaries = signal<GlossaryView[]>([]);
  readonly draft = signal<GlossaryView | null>(null);
  readonly saving = signal(false);
  readonly failure = signal<string | null>(null);

  #ipc = inject(IpcService);

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.glossaries.set(await this.#ipc.invoke("glossaries.list", undefined));
  }

  edit(glossary: GlossaryView): void {
    this.failure.set(null);
    // A copy, terms included: abandoning the form must leave the list as it
    // was, and sharing the arrays would edit it in place.
    this.draft.set({ ...glossary, terms: glossary.terms.map((term) => ({ ...term })) });
  }

  create(): void {
    this.failure.set(null);
    this.draft.set({
      id: crypto.randomUUID(),
      name: "",
      version: 1,
      description: "",
      sourceLanguage: "en",
      targetLanguage: "it",
      terms: [],
    });
  }

  cancel(): void {
    this.draft.set(null);
  }

  patch<K extends keyof GlossaryView>(field: K, value: GlossaryView[K]): void {
    this.draft.update((draft) => (draft === null ? draft : { ...draft, [field]: value }));
  }

  addTerm(): void {
    this.draft.update((draft) => draft === null ? draft : {
      ...draft,
      terms: [...draft.terms, { source: "", rule: "dnt" as TermRule, origin: "glossary" as const }],
    });
  }

  patchTerm(at: number, field: "source" | "target" | "sense" | "note", value: string): void {
    this.draft.update((draft) => {
      if (draft === null) return draft;
      return {
        ...draft,
        terms: draft.terms.map((term, index) => {
          if (index !== at) return term;
          // Absent, not empty: the markdown format round-trips an empty cell
          // as no value at all, and storing "" would come back as a difference.
          const next = { ...term } as GlossaryTerm & Record<string, unknown>;
          if (value.trim() === "") delete next[field];
          else next[field] = value;
          return next as GlossaryTerm;
        }),
      };
    });
  }

  patchRule(at: number, rule: TermRule): void {
    this.draft.update((draft) => draft === null ? draft : {
      ...draft,
      terms: draft.terms.map((term, index) => (index === at ? { ...term, rule } : term)),
    });
  }

  removeTerm(at: number): void {
    this.draft.update((draft) => draft === null ? draft
      : { ...draft, terms: draft.terms.filter((_, index) => index !== at) });
  }

  invalid(draft: GlossaryView): boolean {
    return draft.name.trim() === ""
      || draft.description.trim() === ""
      || draft.terms.some((term) => term.source.trim() === "");
  }

  async save(): Promise<void> {
    const draft = this.draft();
    if (draft === null || this.invalid(draft)) return;

    this.saving.set(true);
    this.failure.set(null);
    try {
      await this.#ipc.invoke("glossary.save", draft);
      this.draft.set(null);
      await this.reload();
    } catch (error) {
      this.failure.set((error as { code?: string }).code ?? "unknown");
    } finally {
      this.saving.set(false);
    }
  }

  /** The file never passes through the window: the main process reads it. */
  async importFile(): Promise<void> {
    this.failure.set(null);
    try {
      if (await this.#ipc.invoke("glossary.importFile", undefined) !== null) await this.reload();
    } catch (error) {
      this.failure.set((error as { code?: string }).code ?? "unknown");
    }
  }

  async exportFile(glossary: GlossaryView): Promise<void> {
    await this.#ipc.invoke("glossary.exportFile", { id: glossary.id });
  }

  /**
   * The question before the glossary goes.
   *
   * It says how many projects are about to lose this terminology — counted in
   * the main process, before anything is destroyed — because that is the
   * number the answer depends on. What the deletion itself detached is a
   * report about something nobody can undo.
   */
  async remove(glossary: GlossaryView): Promise<void> {
    const { confirmed } = await this.#ipc.invoke("ui.confirm", {
      kind: "deleteGlossary",
      detail: { id: glossary.id, name: glossary.name },
    });
    if (!confirmed) return;

    await this.#ipc.invoke("glossary.delete", { id: glossary.id });
    await this.reload();
  }
}
