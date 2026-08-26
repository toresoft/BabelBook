import { ChangeDetectionStrategy, Component, effect, inject, input, OnDestroy, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { TranslocoDirective } from "@jsverse/transloco";
import type { ProjectDetail } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { Exclusions } from "./exclusions/exclusions";
import { ReportView } from "./report/report";
import { Terms } from "./terms/terms";
import { Units } from "./units/units";

const TABS = ["overview", "terms", "exclusions", "units", "report"] as const;
type Tab = (typeof TABS)[number];

/**
 * One book, and everything there is to decide about it.
 *
 * The buttons come from `actions`, which the main process asks of the state
 * machine. Rewriting the rule here — "enabled when the state is paused" —
 * would work until the machine changed, and then nothing would fail: the
 * button would simply stop doing anything.
 */
@Component({
  selector: "bb-project",
  standalone: true,
  imports: [RouterLink, TranslocoDirective, Terms, Exclusions, Units, ReportView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./project.html",
  styleUrl: "./project.css",
})
export class Project implements OnDestroy {
  readonly id = input.required<string>();
  readonly tabs = TABS;

  readonly project = signal<ProjectDetail | null>(null);
  readonly tab = signal<Tab>("overview");
  readonly phase = signal<string | null>(null);

  #ipc = inject(IpcService);
  #unsubscribe: Array<() => void> = [];

  constructor() {
    effect(() => {
      const id = this.id();
      if (id !== "") void this.reload(id);
    });

    // The main process is the one that knows a run moved. Polling would show
    // a stale header, and the gates would appear seconds after they opened.
    this.#unsubscribe.push(this.#ipc.on("project.changed", (changed) => {
      if (changed.id === this.id()) void this.reload();
    }));
    this.#unsubscribe.push(this.#ipc.on("run.phase", (event) => {
      if (event.projectId === this.id()) this.phase.set(event.phase);
    }));
    this.#unsubscribe.push(this.#ipc.on("run.progress", (progress) => {
      if (progress.projectId !== this.id()) return;
      this.project.update((found) => found === null
        ? found
        : { ...found, progress: { done: progress.done, total: progress.total } });
    }));
  }

  ngOnDestroy(): void {
    for (const off of this.#unsubscribe) off();
  }

  async reload(id = this.id()): Promise<void> {
    const found = await this.#ipc.invoke("project.get", { id });
    this.project.set(found);

    // A gate is where the user is needed, so that is where they are put.
    if (found?.state === "waiting-terms") this.tab.set("terms");
    else if (found?.state === "waiting-code") this.tab.set("exclusions");
  }

  show(tab: Tab): void {
    this.tab.set(tab);
  }

  /** Asked of the machine, through the main process. Never re-derived here. */
  can(action: string): boolean {
    return this.project()?.actions.includes(action) ?? false;
  }

  percent(found: ProjectDetail): number {
    return found.progress.total === 0
      ? 0
      : Math.round((found.progress.done / found.progress.total) * 100);
  }

  async start(): Promise<void> {
    await this.#ipc.invoke("run.start", { projectId: this.id() });
    await this.reload();
  }

  async pause(): Promise<void> {
    await this.#ipc.invoke("run.pause", { projectId: this.id() });
    await this.reload();
  }
}
