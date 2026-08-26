import { ChangeDetectionStrategy, Component, inject, input, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective, TranslocoService } from "@jsverse/transloco";
import type { Settings } from "../../../../shared/dto.js";
import { AVAILABLE_LANGUAGES } from "../core/i18n";
import { IpcService } from "../core/ipc.service";

/**
 * The settings that are neither a provider nor a glossary.
 *
 * Two groups, one component: both read and write the same `Settings` record,
 * and splitting them would mean two copies of the same load-patch-reload.
 */
@Component({
  selector: "bb-preferences",
  standalone: true,
  imports: [FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./preferences.html",
  styleUrl: "./preferences.css",
})
export class Preferences {
  readonly group = input.required<"translation" | "application">();
  readonly languages = AVAILABLE_LANGUAGES;

  readonly settings = signal<Settings | null>(null);
  readonly failure = signal<string | null>(null);

  #ipc = inject(IpcService);
  #transloco = inject(TranslocoService);

  constructor() {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.settings.set(await this.#ipc.invoke("settings.get", undefined));
  }

  async patch(change: Partial<Settings>): Promise<void> {
    this.failure.set(null);
    try {
      this.settings.set(await this.#ipc.invoke("settings.set", change));

      // Applied at once. A language setting that only takes effect after a
      // restart looks like a setting that does not work.
      if (change.uiLanguage !== undefined) this.#transloco.setActiveLang(change.uiLanguage);
    } catch (error) {
      this.failure.set((error as { code?: string }).code ?? "unknown");
      // The store refused, so the screen must not keep showing the new value
      // as if it had been accepted.
      await this.reload();
    }
  }

  /** Only the main process may open a dialog, and only it learns the path. */
  async chooseJar(): Promise<void> {
    this.settings.set(await this.#ipc.invoke("settings.chooseJar", undefined));
  }

  async clearJar(): Promise<void> {
    await this.patch({ epubcheckJar: null });
  }
}
