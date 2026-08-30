import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, signal,
} from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { TranslocoDirective } from "@jsverse/transloco";
import { RUN_PHASES, type ProjectDetail, type RunPhase } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { Exclusions } from "./exclusions/exclusions";
import { ReportView } from "./report/report";
import { Side } from "./side/side";
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
  imports: [RouterLink, TranslocoDirective, Terms, Exclusions, Units, ReportView, Side],
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

  /**
   * What the run is doing right now, which is not what the book is.
   *
   * Two numbers, not one. `project.progress` says how much of the book is
   * translated: a fact of the database, monotone, true with nothing running.
   * This says how far the current phase has got, and it restarts at every
   * phase — and it counts what its own phase counts, which is samples in one
   * phase and batches in another, not units of the book. Written into both,
   * it made the screen ask one question twice and answer it wrong.
   */
  readonly phaseProgress = signal<{ phase: RunPhase; done: number; total: number } | null>(null);

  /** How many phases a run declares: the denominator of the upper bar. */
  readonly phaseCount = RUN_PHASES.length;

  /**
   * The phase the run is in, from the phase event; the last progress event is
   * the fallback for the moment before one arrives.
   */
  readonly currentPhase = computed<RunPhase | null>(() => {
    const named = this.phase();
    if (named !== null && RUN_PHASES.includes(named as RunPhase)) return named as RunPhase;
    return this.phaseProgress()?.phase ?? null;
  });

  /**
   * The counter of the phase on screen, and of no other. A counter kept from
   * the phase before would sit under the new phase's name claiming a progress
   * nobody measured.
   */
  readonly phaseCounts = computed(() => {
    const running = this.phaseProgress();
    if (running === null || running.total === 0) return null;
    return running.phase === this.currentPhase() ? running : null;
  });

  /**
   * Live spend, from `run.usage`. It overrides `found.tokens` only while the
   * run is alive; once reloaded state says the run is over, the database row
   * is the truth again and this goes back to null.
   */
  readonly liveTokens = signal<{ in: number; out: number; reasoning: number } | null>(null);

  #ipc = inject(IpcService);
  #router = inject(Router);
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
      // Only `translate` counts the book: its `done`/`total` are the units of
      // the book itself, the same two numbers the database answers with. Every
      // other phase counts its own work — samples, batches — and writing those
      // into the book's count made the book claim a progress it did not have.
      if (progress.phase === "translate") {
        this.project.update((found) => found === null
          ? found
          : { ...found, progress: { done: progress.done, total: progress.total } });
      }
      this.phaseProgress.set({ phase: progress.phase, done: progress.done, total: progress.total });
    }));
    this.#unsubscribe.push(this.#ipc.on("run.usage", (usage) => {
      if (usage.projectId !== this.id()) return;
      this.liveTokens.set({ in: usage.tokensIn, out: usage.tokensOut, reasoning: usage.reasoningTokens });
    }));
  }

  ngOnDestroy(): void {
    for (const off of this.#unsubscribe) off();
  }

  async reload(id = this.id()): Promise<void> {
    const found = await this.#ipc.invoke("project.get", { id });
    this.project.set(found);

    // A phase bar left on screen after the run ended is a lie with a date on
    // it: the reloaded state is the only thing that gets to say the run is
    // still going, so a reload that finds it isn't clears both live signals.
    if (found?.state !== "running") {
      this.phase.set(null);
      this.phaseProgress.set(null);
      this.liveTokens.set(null);
    }

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

  phasePercent(running: { done: number; total: number }): number {
    return running.total === 0
      ? 0
      : Math.round((running.done / running.total) * 100);
  }

  /**
   * The translating phase counts the units of the book: its counter and the
   * book's are the same sentence, word for word. The bar stays — it is the
   * longest phase, and a phase without one reads as a phase that is stuck —
   * and the sentence is printed once, under the count that owns it.
   */
  duplicatesBookCount(phase: RunPhase): boolean {
    return phase === "translate";
  }

  /** Which of the run's phases this one is, counted from one. */
  phaseStep(phase: RunPhase): number {
    return RUN_PHASES.indexOf(phase) + 1;
  }

  stepPercent(phase: RunPhase): number {
    return Math.round((this.phaseStep(phase) / this.phaseCount) * 100);
  }

  /** The live spend while a run is going, the database's own answer otherwise. */
  tokens(found: ProjectDetail): { in: number; out: number; reasoning: number } {
    return this.liveTokens() ?? found.tokens;
  }

  async start(): Promise<void> {
    await this.#ipc.invoke("run.start", { projectId: this.id() });
    await this.reload();
  }

  /**
   * The book again, from translations that already exist. No model is asked
   * anything, so this costs nothing and is the way back from a composition
   * that came out wrong.
   */
  async compose(): Promise<void> {
    await this.#ipc.invoke("run.compose", { projectId: this.id() });
    await this.reload();
  }

  async pause(): Promise<void> {
    await this.#ipc.invoke("run.pause", { projectId: this.id() });
    this.phase.set(null);
    this.phaseProgress.set(null);
    this.liveTokens.set(null);
    await this.reload();
  }

  /** The way back, as a button: the trail beside it is the link. */
  toLibrary(): void {
    void this.#router.navigate(["/"]);
  }

  /**
   * Deleting asks first, and the question names the book — same act as the
   * library's, just reached from the book's own screen.
   */
  async remove(): Promise<void> {
    const found = this.project();
    if (found === null) return;

    const { confirmed } = await this.#ipc.invoke("ui.confirm", {
      kind: "deleteProject", detail: { title: found.title },
    });
    if (!confirmed) return;

    await this.#ipc.invoke("project.delete", { id: found.id });
    void this.#router.navigate(["/"]);
  }
}
