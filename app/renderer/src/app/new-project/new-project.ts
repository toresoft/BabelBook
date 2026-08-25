import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { TranslocoDirective } from "@jsverse/transloco";
import type { CreatedProject } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { estimate } from "./estimate";

const TARGET_LANGUAGES = ["it", "en", "fr", "de", "es", "pt"] as const;

@Component({
  selector: "bb-new-project",
  standalone: true,
  imports: [FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./new-project.html",
  styleUrl: "./new-project.css",
})
export class NewProject {
  readonly languages = TARGET_LANGUAGES;

  readonly chosenName = signal<string | null>(null);
  readonly analysing = signal(false);
  readonly project = signal<CreatedProject | null>(null);
  readonly failure = signal<{ key: string; params?: Record<string, unknown> } | null>(null);

  readonly targetLanguage = signal("it");
  readonly sourceLanguage = signal("");
  readonly description = signal("");

  /**
   * The estimate is built on the units the analysis actually found, which is
   * why the book is ingested before this screen asks for anything. A guess
   * made from the file size would be a number the user believes and we made up.
   */
  readonly estimated = computed(() => {
    const found = this.project();
    return found === null ? null : estimate({ words: found.words, priceIn: null, priceOut: null });
  });

  #ipc = inject(IpcService);
  #router = inject(Router);

  async choose(): Promise<void> {
    this.failure.set(null);
    const chosen = await this.#ipc.invoke("project.chooseEpub", undefined);
    if (chosen === null) return;

    this.chosenName.set(chosen.name);
    this.analysing.set(true);
    try {
      const created = await this.#ipc.invoke("project.create", {
        epubPath: chosen.path,
        targetLanguage: this.targetLanguage(),
      });
      this.project.set(created);
      this.sourceLanguage.set(created.declaredLanguage ?? "");
    } catch (error) {
      const failed = error as { format?: string };
      this.failure.set(failed.format === undefined
        ? { key: "errors.noBridge" }
        : { key: "codes.unsupported-format", params: { format: failed.format } });
    } finally {
      this.analysing.set(false);
    }
  }

  async create(): Promise<void> {
    const found = this.project();
    if (found === null) return;

    await this.#ipc.invoke("project.update", {
      id: found.id,
      targetLanguage: this.targetLanguage(),
      sourceLanguage: this.sourceLanguage() === "" ? null : this.sourceLanguage(),
      description: this.description(),
    });
    await this.#router.navigateByUrl("/");
  }

  /**
   * Abandoning removes the project and its workspace.
   *
   * The analysis had to write to answer at all, and leaving it behind would
   * show a project in the library the user believes they cancelled.
   */
  async cancel(): Promise<void> {
    const found = this.project();
    if (found !== null) await this.#ipc.invoke("project.delete", { id: found.id });
    await this.#router.navigateByUrl("/");
  }
}
