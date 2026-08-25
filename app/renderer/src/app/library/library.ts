import { ChangeDetectionStrategy, Component, inject, OnDestroy, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { TranslocoDirective } from "@jsverse/transloco";
import type { ProjectSummary } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";

@Component({
  selector: "bb-library",
  standalone: true,
  imports: [FormsModule, RouterLink, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./library.html",
  styleUrl: "./library.css",
})
export class Library implements OnDestroy {
  readonly projects = signal<ProjectSummary[]>([]);
  readonly filter = signal("");
  readonly loading = signal(true);

  #ipc = inject(IpcService);
  #unsubscribe: (() => void) | null = null;

  constructor() {
    void this.reload();
    // The main process is the one that knows a project changed — a translation
    // finished, a project was deleted from another window. Polling would show
    // a stale library between ticks.
    this.#unsubscribe = this.#ipc.on("project.changed", () => void this.reload());
  }

  ngOnDestroy(): void {
    this.#unsubscribe?.();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.projects.set(await this.#ipc.invoke("projects.list", { filter: this.filter() }));
    this.loading.set(false);
  }

  onFilter(value: string): void {
    this.filter.set(value);
    void this.reload();
  }

  percent(project: ProjectSummary): number {
    return project.progress.total === 0
      ? 0
      : Math.round((project.progress.done / project.progress.total) * 100);
  }
}
