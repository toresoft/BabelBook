import {
  ChangeDetectionStrategy, Component, effect, inject, input, OnDestroy, signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { TranslocoDirective, TranslocoService } from "@jsverse/transloco";
import { isBucket } from "../../../../shared/buckets.js";
import type { ProjectSummary } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { tone as toneOf, type Tone } from "../core/tones";

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
  readonly bucket = input<string>("all");

  #ipc = inject(IpcService);
  #transloco = inject(TranslocoService);
  #unsubscribe: Array<() => void> = [];

  constructor() {
    // A route change is a new question for the database, not a new component.
    // The effect is also the first load's driver: the component is created
    // with a bucket already, so an eager reload here would ask twice.
    effect(() => {
      this.bucket();
      void this.reload();
    });
    // The main process is the one that knows a project changed — a translation
    // finished, a project was deleted from another window. Polling would show
    // a stale library between ticks.
    this.#unsubscribe.push(this.#ipc.on("project.changed", () => void this.reload()));
    this.#unsubscribe.push(this.#ipc.on("run.progress", (progress) => {
      this.projects.update((projects) => projects.map((project) =>
        project.id === progress.projectId
          ? { ...project, progress: { done: progress.done, total: progress.total } }
          : project));
    }));
  }

  ngOnDestroy(): void {
    for (const off of this.#unsubscribe) off();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    const routeBucket = this.bucket();
    const bucket = isBucket(routeBucket) ? routeBucket : "all";
    this.projects.set(await this.#ipc.invoke("projects.list", { filter: this.filter(), bucket }));
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

  /**
   * A count as the reader's language writes it.
   *
   * `5647` and `5.647` are the same number and not the same glance: a shelf is
   * read at a glance, and the separator is what spares the reader from
   * counting the figures.
   */
  count(n: number): string {
    return new Intl.NumberFormat(this.#transloco.getActiveLang()).format(n);
  }

  /** The book the composition wrote, opened with whatever the desktop uses. */
  open(project: ProjectSummary): void {
    if (project.outputPath === null) return;
    void this.#ipc.invoke("file.open", { path: project.outputPath }).catch(() => {});
  }

  /** The badge tone the state wears: the colour of what the state means. */
  tone(state: string): Tone {
    return toneOf(state);
  }

  /** Start and resume are the same command: the machine decides which is lawful. */
  onStart(project: ProjectSummary): void {
    // A refusal (an open gate, a busy engine) leaves the tile in the state it
    // shows; the screens that explain why are the next plan's work.
    void this.#ipc.invoke("run.start", { projectId: project.id }).catch(() => {});
  }

  onPause(project: ProjectSummary): void {
    void this.#ipc.invoke("run.pause", { projectId: project.id }).catch(() => {});
  }

  /**
   * Deleting asks first, and the question names the book.
   *
   * The main process assembles the sentence and the platform draws the box;
   * the window only says which act it is about to perform.
   */
  async remove(project: ProjectSummary): Promise<void> {
    const { confirmed } = await this.#ipc.invoke("ui.confirm", {
      kind: "deleteProject", detail: { title: project.title },
    });
    if (!confirmed) return;

    await this.#ipc.invoke("project.delete", { id: project.id });
    await this.reload();
  }
}
