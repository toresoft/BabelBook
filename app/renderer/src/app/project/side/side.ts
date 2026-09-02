import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, output, signal,
} from "@angular/core";
import { TranslocoDirective, TranslocoService } from "@jsverse/transloco";
import type { IpcFailure, LogLine, ProjectDetail } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { between, spell } from "../../core/durations";
import { tell } from "../../core/failure";
import { tone as toneOf, type Tone } from "../../core/tones";
import { Detail } from "../detail";
import { ProgressPanel } from "./progress-panel";
import { ProjectSettings } from "./project-settings";

/** The event names `primary()` can hand back, and the testid each one carries. */
const ACTION_TESTIDS = { START: "project-start", PAUSE: "project-pause", COMPOSE: "project-compose" } as const;

/** One card of the things worth knowing before spending. */
interface AlertCard {
  kind: "stopped" | "layout" | "overlays" | "description";
  testid: string;
  tone: "danger" | "warning" | "muted";
}

/** The card's title, keyed by catalogue; the stopped card carries two, by state. */
const ALERT_TITLES: Record<Exclude<AlertCard["kind"], "stopped">, string> = {
  layout: "alerts.layout",
  overlays: "alerts.overlays",
  description: "alerts.noDescription",
};

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
  imports: [Detail, ProgressPanel, ProjectSettings, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./side.html",
  styleUrls: ["../list.css", "./side.css"],
})
export class Side implements OnDestroy {
  readonly project = input.required<ProjectDetail>();

  readonly start = output<void>();
  readonly pause = output<void>();
  readonly compose = output<void>();
  readonly download = output<void>();
  readonly remove = output<void>();

  /** Whether the description dialog is open; the description itself stays on `project()`. */
  readonly descriptionOpen = signal(false);

  /** Whether the edit dialog is open. */
  readonly editOpen = signal(false);

  /** Which of the panel's two cards is showing; the reader's choice, kept where it was made. */
  readonly panel = signal<"progress" | "log">("progress");

  /** The last run's story, read when its tab is the one open. */
  readonly log = signal<LogLine[]>([]);

  /** Which of the log's two faces is showing: the curated one, or the raw one it is made from. */
  readonly view = signal<"log" | "raw">("log");

  /** The raw diagnostic lines, asked for only when the raw view is the one showing. */
  readonly raw = signal<string[]>([]);

  /** The folder the raw lines were read from, empty until it is known. */
  readonly rawPath = signal<string>("");

  /** Whether the raw view lets the `debug` lines through. */
  readonly showDebug = signal(false);

  /** The raw lines the filter lets through, newest last, as they were written. */
  readonly rawLines = computed(() => this.raw().filter((line) => {
    if (this.showDebug()) return true;
    try {
      return (JSON.parse(line) as { level?: string }).level !== "debug";
    } catch {
      return true;
    }
  }));

  #transloco = inject(TranslocoService);
  #ipc = inject(IpcService);
  #off: Array<() => void> = [];
  #beat: ReturnType<typeof setTimeout> | null = null;
  #pending = false;

  constructor() {
    // The log is the one thing the column does not arrive with: it asks for
    // it when its tab opens, and again whenever the project says something
    // changed — a run reports far oftener than an eye reads.
    effect(() => {
      if (this.panel() === "log") void this.#loadLog();
    });
    this.#off.push(this.#ipc.on("project.changed", (changed) => {
      if (changed.id === this.project().id && this.panel() === "log") this.#soon();
    }));
  }

  ngOnDestroy(): void {
    for (const off of this.#off) off();
    if (this.#beat !== null) clearTimeout(this.#beat);
  }

  /** True when the machine would accept this event right now. */
  can(action: string): boolean {
    return this.project().actions.includes(action);
  }

  /**
   * Editing is refused only while the engine is actually alive.
   *
   * A suspended run — paused, or stopped at a gate — is exactly when someone
   * changes their mind about the model, so the button stays on there. What
   * protects the work already done is the confirmation inside the dialog, not
   * a button that is off.
   */
  canEdit(): boolean {
    const state = this.project().state;
    return state !== "running" && state !== "composing";
  }

  /**
   * The cards the column shows before anything is spent on the book: why the
   * last run stopped, what the translation will not keep, what would help it.
   *
   * At most three, each built from a fact the project already holds — a card
   * that asked the main process a question would be a second screen inside
   * this one.
   */
  readonly alerts = computed<AlertCard[]>(() => {
    const found = this.project();
    const cards: AlertCard[] = [];

    // Two endings now, not one. `failed` means resuming would not fix it;
    // `paused` with a reason is a run waiting for something outside itself,
    // and calling it "Rifiutato" was telling the reader the wrong thing.
    if (found.state === "failed" || (found.state === "paused" && this.#stopped() !== null)) {
      cards.push({
        kind: "stopped",
        testid: "alert-stopped",
        tone: found.state === "failed" ? "danger" : "warning",
      });
    }
    if (found.layout !== "reflowable") cards.push({ kind: "layout", testid: "alert-layout", tone: "warning" });
    if (found.hasOverlays) cards.push({ kind: "overlays", testid: "alert-overlays", tone: "warning" });
    if (found.description === null) {
      cards.push({ kind: "description", testid: "alert-description", tone: "muted" });
    }
    return cards;
  });

  /** The classified reason of the last phase that carried one, whatever its outcome. */
  #stopped(): IpcFailure | null {
    for (const entry of [...this.project().phases].reverse()) {
      const code = entry.info?.["code"];
      if (typeof code !== "string") continue;
      const fault = entry.info?.["fault"];
      return { code, fault: (typeof fault === "string" ? fault : "defect") as IpcFailure["fault"] };
    }
    return null;
  }

  titleOf(card: AlertCard): string {
    if (card.kind !== "stopped") return ALERT_TITLES[card.kind];
    return this.project().state === "failed" ? "alerts.failed" : "alerts.paused";
  }

  bodyOf(card: AlertCard): string | null {
    if (card.kind === "layout") return this.#transloco.translate("project.fixedLayout");
    if (card.kind === "overlays") return this.#transloco.translate("overlays.warning");
    if (card.kind === "description") return this.#transloco.translate("project.noDescription");
    const failure = this.#stopped();
    return failure === null ? null : tell(this.#transloco, failure).body;
  }

  /** What to do next, which is the whole point of classifying. */
  hintOf(card: AlertCard): string | null {
    if (card.kind !== "stopped") return null;
    const failure = this.#stopped();
    return failure === null ? null : tell(this.#transloco, failure).hint;
  }

  /** True where the fix is in Settings rather than in pressing Resume. */
  settingsHelp(): boolean {
    const fault = this.#stopped()?.fault;
    return fault === "config" || fault === "exhausted";
  }

  /** The badge tone the state wears: the colour of what the state means. */
  tone(): Tone {
    return toneOf(this.project().state);
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
   * Once the book is downloadable, that is the act worth top billing: the
   * file that already exists is more useful than the offer to make another
   * one. It does not, though, take composing off the column — `done` is not
   * final, and `COMPOSE` is the retry the machine deliberately still allows
   * (see `project.machine.ts`'s `done` state). When both apply, `showComposeBeside()`
   * says so, and the compose button stays, small, next to the download.
   */
  isDownloadable(): boolean {
    const found = this.project();
    return found.state === "done" && found.outputPath !== null;
  }

  /** True when composing again belongs beside the download, not instead of it. */
  showComposeBeside(): boolean {
    return this.isDownloadable() && this.primary()?.event === "COMPOSE";
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

  /**
   * How long the last run has been going, or went. Null when none has ever
   * run. The words themselves come from `between`, which the phases share.
   */
  elapsed(): string | null {
    const started = this.project().runStartedAt;
    if (started === null) return null;
    return between(this.#transloco, started, this.project().runEndedAt ?? new Date().toISOString());
  }

  /** A timestamp as the reader's own calendar writes it, not as the database stored it. */
  date(iso: string): string {
    return new Intl.DateTimeFormat(this.#transloco.getActiveLang(), { dateStyle: "medium" }).format(new Date(iso));
  }

  /** A line's moment as the reader's own clock writes it: the log is a story of today before it is one of dates. */
  time(iso: string): string {
    return new Intl.DateTimeFormat(this.#transloco.getActiveLang(), { timeStyle: "medium" }).format(new Date(iso));
  }

  /**
   * The sentence a line says, in the reader's language. Event codes carry
   * their own catalogue entries; state codes are assembled from the phase's
   * name and how it ended. A code nobody catalogued shows as itself: a bare
   * word the reader can quote beats a blank line where a reason should be.
   */
  phrase(line: LogLine): string {
    if (line.kind === "event") {
      // The parameters were never passed, so a catalogue entry with
      // placeholders showed its `{{ }}` to the reader. The retry line is
      // nothing but its numbers.
      const info = { ...(line.info ?? {}) };
      // The sink writes milliseconds; the catalogue asks for seconds. The
      // conversion is a choice of language, not of data, so it lives here and
      // not in the log: the register keeps the milliseconds it measured.
      if (typeof info["waitMs"] === "number") info["seconds"] = Math.round(info["waitMs"] / 1000);
      if (typeof info["elapsedMs"] === "number") info["seconds"] = Math.round(info["elapsedMs"] / 1000);
      // A reason is a stable code, and a stable code is not Italian.
      // Interpolated as it arrives it put `PROVIDER_RATE_LIMITED` in the
      // middle of a sentence — the thing the catalogue exists to prevent,
      // reintroduced one layer further in. Untranslatable it stays as it is:
      // a word the reader can quote beats a gap where a reason should be.
      if (typeof info["reason"] === "string") {
        info["reason"] = this.#sentence(`codes.${info["reason"]}`, info["reason"]);
      }
      return this.#sentence(`codes.${line.code}`, line.code, info);
    }
    const [, subject, outcome = "left"] = line.code.split(".");
    if (line.code.startsWith("phase.")) {
      const seconds = line.info?.["durationSeconds"];
      return this.#transloco.translate(`project.log.phase.${outcome}`, {
        phase: this.#sentence(`phase.${subject}`, subject),
        duration: typeof seconds === "number" ? spell(this.#transloco, seconds) : "—",
      });
    }
    return this.#sentence(`state.${subject}`, subject);
  }

  /** The catalogue's sentence for a key, or the fallback when it has none. */
  #sentence(key: string, fallback: string, params: Record<string, unknown> = {}): string {
    const sentence = this.#transloco.translate(key, params);
    return sentence === key ? fallback : sentence;
  }

  async #loadLog(): Promise<void> {
    this.log.set(await this.#ipc.invoke("run.events", { projectId: this.project().id }));
  }

  async #loadRaw(): Promise<void> {
    const answer = await this.#ipc.invoke("run.diagnostics", { projectId: this.project().id });
    this.raw.set(answer.lines);
    this.rawPath.set(answer.path);
  }

  showRaw(): void {
    this.view.set("raw");
    void this.#loadRaw();
  }

  copyRaw(): void {
    void navigator.clipboard.writeText(this.rawLines().join("\n"));
  }

  revealRaw(): void {
    if (this.rawPath() !== "") void this.#ipc.invoke("file.reveal", { path: this.rawPath() });
  }

  /**
   * A reload now, and no more than one a second after it — the same breath
   * the units take, for the same reason: the first message is answered at
   * once, and whatever arrives during that second by one reload at its end.
   */
  #soon(): void {
    if (this.#beat !== null) {
      this.#pending = true;
      return;
    }
    void this.#loadLog();
    this.#beat = setTimeout(() => {
      this.#beat = null;
      if (!this.#pending) return;
      this.#pending = false;
      this.#soon();
    }, 1000);
  }
}
