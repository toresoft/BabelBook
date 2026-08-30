import { ChangeDetectionStrategy, Component, inject, input, output, signal } from "@angular/core";
import { TranslocoDirective, TranslocoService } from "@jsverse/transloco";
import type { ProjectDetail } from "../../../../../shared/dto.js";
import { Detail } from "../detail";

/** The daisyUI tone a state's badge wears — the same rule the library's tiles follow. */
type Tone = "primary" | "success" | "error" | "warning" | "neutral";

const TONES: Record<string, Tone> = {
  ready: "primary",
  running: "primary",
  composing: "primary",
  done: "success",
  failed: "error",
  "waiting-terms": "warning",
  "waiting-code": "warning",
};

/** The event names `primary()` can hand back, and the testid each one carries. */
const ACTION_TESTIDS = { START: "project-start", PAUSE: "project-pause", COMPOSE: "project-compose" } as const;

/**
 * The book, beside the work.
 *
 * What used to be a header above the tabs: it scrolled away with the list and
 * was gone exactly when a long list made it worth having. Here it stays put,
 * whichever tab is open.
 *
 * It asks nothing of the main process: the project arrives already loaded, and
 * the acts are handed back to the screen that owns them.
 */
@Component({
  selector: "bb-side",
  standalone: true,
  imports: [Detail, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./side.html",
  styleUrls: ["../list.css", "./side.css"],
})
export class Side {
  readonly project = input.required<ProjectDetail>();

  readonly start = output<void>();
  readonly pause = output<void>();
  readonly compose = output<void>();
  readonly download = output<void>();
  readonly remove = output<void>();

  /** Whether the description dialog is open; the description itself stays on `project()`. */
  readonly descriptionOpen = signal(false);

  #transloco = inject(TranslocoService);

  /** True when the machine would accept this event right now. */
  can(action: string): boolean {
    return this.project().actions.includes(action);
  }

  /** The badge tone the state wears: the colour of what the state means. */
  tone(): Tone {
    return TONES[this.project().state] ?? "neutral";
  }

  /**
   * The one act the column offers, and the event it sends. Read off the
   * machine's own answer, never re-derived from the state's name: a
   * condition written here a second time is a condition that can disagree
   * with the machine the day it changes.
   */
  primary(): { label: string; event: "START" | "PAUSE" | "COMPOSE" } | null {
    if (this.can("PAUSE")) return { label: "library.pause", event: "PAUSE" };
    if (this.can("RESUME")) return { label: "library.resume", event: "START" };
    if (this.can("START")) return { label: "library.translate", event: "START" };
    if (this.can("COMPOSE")) return { label: "library.compose", event: "COMPOSE" };
    return null;
  }

  /**
   * Once the book is downloadable, that overtakes composing it again as the
   * one act worth top billing: the file that already exists is more useful
   * than the offer to make another one.
   */
  isDownloadable(): boolean {
    const found = this.project();
    return found.state === "done" && found.outputPath !== null;
  }

  /** The testid the event's own button carries, so the gates and the live run keep clicking it by name. */
  testIdFor(event: "START" | "PAUSE" | "COMPOSE"): string {
    return ACTION_TESTIDS[event];
  }

  onPrimary(event: "START" | "PAUSE" | "COMPOSE"): void {
    if (event === "START") this.start.emit();
    else if (event === "PAUSE") this.pause.emit();
    else this.compose.emit();
  }

  /** How long the last run has been going, or went. Null when none has ever run. */
  elapsed(): string | null {
    const started = this.project().runStartedAt;
    if (started === null) return null;
    const end = this.project().runEndedAt ?? new Date().toISOString();
    const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(started)) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  /** A timestamp as the reader's own calendar writes it, not as the database stored it. */
  date(iso: string): string {
    return new Intl.DateTimeFormat(this.#transloco.getActiveLang(), { dateStyle: "medium" }).format(new Date(iso));
  }
}
