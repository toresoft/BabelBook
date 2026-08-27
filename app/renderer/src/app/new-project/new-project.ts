import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { TranslocoDirective } from "@jsverse/transloco";
import type { CreatedProject, Provider } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { estimate } from "../../../../shared/estimate.js";

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

  /** The configured providers, with the models their endpoints declared. */
  readonly providers = signal<Provider[]>([]);
  readonly providerId = signal<string | null>(null);
  readonly modelId = signal<string | null>(null);

  readonly chosenProvider = computed(() =>
    this.providers().find((provider) => provider.id === this.providerId()) ?? null);

  /**
   * The estimate is built on the units the analysis actually found, which is
   * why the book is ingested before this screen asks for anything. A guess
   * made from the file size would be a number the user believes and we made up.
   *
   * The prices are the chosen model's as the catalogue declared them: absent
   * when unknown, never invented, so the estimate says tokens only until it
   * can honestly say money.
   */
  readonly estimated = computed(() => {
    const found = this.project();
    if (found === null) return null;
    const model = this.chosenProvider()?.models.find((m) => m.id === this.modelId()) ?? null;
    return estimate({
      words: found.words,
      priceIn: model?.priceIn ?? null,
      priceOut: model?.priceOut ?? null,
    });
  });

  #ipc = inject(IpcService);
  #router = inject(Router);

  constructor() {
    void this.loadProviders();
  }

  async loadProviders(): Promise<void> {
    this.providers.set(await this.#ipc.invoke("providers.list", undefined));
  }

  /** Choosing a provider takes its first model along, as the form's best guess. */
  pickProvider(id: string): void {
    this.providerId.set(id);
    const first = this.providers().find((provider) => provider.id === id)?.models[0]?.id ?? null;
    this.modelId.set(first);
  }

  pickModel(id: string): void {
    this.modelId.set(id);
  }

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
      const failed = error as { code?: string; format?: string };
      this.failure.set(failed.code === "UNSUPPORTED_FORMAT"
        ? { key: "codes.unsupported-format", params: { format: failed.format ?? "?" } }
        : { key: "errors.noBridge" });
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
      providerId: this.providerId() ?? undefined,
      modelId: this.modelId() ?? undefined,
    });
    await this.#router.navigateByUrl("/");
  }

  /**
   * Abandoning removes the project and its workspace — after asking.
   *
   * The analysis had to write to answer at all, and leaving it behind would
   * show a project in the library the user believes they cancelled. But the
   * writing is real work being thrown away, so the question comes first; with
   * nothing analysed yet, there is nothing to destroy and no question to ask.
   */
  async cancel(): Promise<void> {
    const found = this.project();
    if (found !== null) {
      const { confirmed } = await this.#ipc.invoke("ui.confirm", {
        kind: "abandonProject",
        detail: { title: found.title },
      });
      if (!confirmed) return;
      await this.#ipc.invoke("project.delete", { id: found.id });
    }
    await this.#router.navigateByUrl("/");
  }
}
