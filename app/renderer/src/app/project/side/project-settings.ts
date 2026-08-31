import {
  ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective } from "@jsverse/transloco";
import type { ProjectDetail, Provider } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { TARGET_LANGUAGES } from "../../core/languages";
import { Detail } from "../detail";

/**
 * A project, after it was created.
 *
 * Until this existed a book's provider could only be chosen on the way in, and
 * a provider chosen once was a provider forever. The dialog is the same modal
 * shell the column already uses for the description: one guest at a time in
 * front of the work, not a second screen.
 *
 * It asks the main process for exactly one thing — the provider list — because
 * the project itself arrives already loaded from the column above it.
 */
@Component({
  selector: "bb-project-settings",
  standalone: true,
  imports: [Detail, FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./project-settings.html",
  styleUrl: "./project-settings.css",
})
export class ProjectSettings {
  readonly project = input.required<ProjectDetail>();
  readonly closed = output<void>();

  readonly languages = TARGET_LANGUAGES;

  readonly providers = signal<Provider[]>([]);
  readonly providerId = signal<string | null>(null);
  readonly modelId = signal<string | null>(null);
  readonly targetLanguage = signal("it");
  readonly sourceLanguage = signal("");
  readonly description = signal("");
  readonly autoAcceptTerms = signal(true);
  readonly autoAcceptExclusions = signal(true);
  readonly saving = signal(false);

  readonly usable = computed(() =>
    this.providers().filter((provider) => provider.models.length > 0));

  readonly chosenProvider = computed(() =>
    this.providers().find((provider) => provider.id === this.providerId()) ?? null);

  readonly canSave = computed(() => this.providerId() !== null && this.modelId() !== null);

  /**
   * Whether this form changes what the stored translations were made under.
   *
   * `projectCacheKey` digests the model and both languages; the provider is
   * not in it, because the key names the model and not who served it. Change
   * any of the three and the work already paid for stays on the disk and
   * stops counting — which is the question the confirmation asks.
   */
  readonly contractChanged = computed(() => {
    const found = this.project();
    const source = this.sourceLanguage() === "" ? null : this.sourceLanguage();
    return this.modelId() !== found.modelId
      || this.targetLanguage() !== found.targetLanguage
      || source !== found.sourceLanguage;
  });

  #ipc = inject(IpcService);

  // Not the constructor: a required input is not there yet while it runs, and
  // the form is built out of the project's own values.
  ngOnInit(): void {
    void this.#load();
  }

  async #load(): Promise<void> {
    const found = this.project();
    this.providers.set(await this.#ipc.invoke("providers.list", undefined));
    this.providerId.set(found.providerId);
    this.modelId.set(found.modelId);
    this.targetLanguage.set(found.targetLanguage);
    this.sourceLanguage.set(found.sourceLanguage ?? "");
    this.description.set(found.description ?? "");
    this.autoAcceptTerms.set(found.autoAcceptTerms);
    this.autoAcceptExclusions.set(found.autoAcceptExclusions);
  }

  /** Choosing a provider takes its first model along, as the form's best guess. */
  pickProvider(id: string): void {
    this.providerId.set(id);
    this.modelId.set(this.providers().find((provider) => provider.id === id)?.models[0]?.id ?? null);
  }

  pickModel(id: string): void {
    this.modelId.set(id);
  }

  async save(): Promise<void> {
    const found = this.project();
    const providerId = this.providerId();
    const modelId = this.modelId();
    if (providerId === null || modelId === null) return;

    // Only when there is something to lose. A question with no stake teaches
    // people to click through the questions that have one.
    if (this.contractChanged() && found.progress.done > 0) {
      const { confirmed } = await this.#ipc.invoke("ui.confirm", {
        kind: "contractChange",
        detail: { title: found.title, done: found.progress.done },
      });
      if (!confirmed) return;
    }

    this.saving.set(true);
    try {
      await this.#ipc.invoke("project.update", {
        id: found.id,
        providerId,
        modelId,
        targetLanguage: this.targetLanguage(),
        sourceLanguage: this.sourceLanguage() === "" ? null : this.sourceLanguage(),
        description: this.description(),
        autoAcceptTerms: this.autoAcceptTerms(),
        autoAcceptExclusions: this.autoAcceptExclusions(),
      });
    } finally {
      this.saving.set(false);
    }
    // The reload arrives on its own: the main process broadcasts
    // `project.changed`, and the screen above is already listening.
    this.closed.emit();
  }
}
