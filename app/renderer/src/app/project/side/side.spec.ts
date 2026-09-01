import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import it_IT from "../../../../../locales/it.json";
import type { LogLine, ProjectDetail } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { provideI18n } from "../../core/i18n";
import { Side } from "./side";

const detail: ProjectDetail = {
  id: "p1",
  title: "A Book",
  author: "An Author",
  coverPath: null,
  // Null here, not a placeholder sentence: the fixture's default project has
  // no description, so a test that wants one asks for it with `{ ...detail }`.
  description: null,
  sourceLanguage: "en",
  targetLanguage: "it",
  state: "ready",
  progress: { done: 0, total: 10 },
  layout: "reflowable",
  hasOverlays: false,
  providerId: null,
  modelId: null,
  providerName: null,
  modelName: null,
  autoAcceptTerms: true,
  autoAcceptExclusions: true,
  actions: ["START"],
  tokens: { in: 0, out: 0, reasoning: 0 },
  cost: null,
  createdAt: "2026-08-24",
  outputPath: null,
  runStartedAt: null,
  runEndedAt: null,
  phases: [
    { phase: "analyze", state: "waiting", startedAt: null, endedAt: null, done: null, total: null, info: null },
    { phase: "candidates", state: "waiting", startedAt: null, endedAt: null, done: null, total: null, info: null },
    { phase: "code-index", state: "waiting", startedAt: null, endedAt: null, done: null, total: null, info: null },
    { phase: "translate", state: "waiting", startedAt: null, endedAt: null, done: 0, total: 10, info: null },
    { phase: "compose", state: "waiting", startedAt: null, endedAt: null, done: null, total: null, info: null },
  ],
  finishedAt: null,
};

/** A phase as a run leaves it: the counts blank, the info whatever the test says. */
function phase(
  name: ProjectDetail["phases"][number]["phase"],
  state: ProjectDetail["phases"][number]["state"],
  info: Record<string, unknown> | null = null,
) {
  return { phase: name, state, startedAt: null, endedAt: null, done: null, total: null, info };
}

/**
 * The bridge's stand-in: it answers whatever a test scripted, an empty
 * something to the rest, and remembers every channel it was asked — the
 * tests distinguish "asked" from "never asked", which a plain stub cannot.
 */
const SCRIPTED: Record<string, unknown> = {};
const EMPTY: Record<string, unknown> = {
  "run.events": [],
  "run.diagnostics": { lines: [], path: "" },
};
const ipc = {
  invoked: [] as string[],
  answer(channel: string, payload: unknown): void {
    SCRIPTED[channel] = payload;
  },
  invoke(channel: string): Promise<unknown> {
    ipc.invoked.push(channel);
    return Promise.resolve(SCRIPTED[channel] ?? EMPTY[channel] ?? []);
  },
  on: () => () => {},
};

function mount(overrides: Partial<ProjectDetail> = {}) {
  // A test that mounts twice (one project, then another) needs a fresh
  // module each time: the first `createComponent` instantiates the testing
  // module, and Angular refuses to configure an instantiated one again.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [Side],
    providers: [
      ...provideI18n("it"),
      // The log asks the main process; here it answers with nothing, and no
      // listener ever fires.
      { provide: IpcService, useValue: ipc },
    ],
  });
  const fixture = TestBed.createComponent(Side);
  fixture.componentRef.setInput("project", { ...detail, ...overrides });
  // The questions of this mount only: what a previous test asked is its own
  // business, and the scripted answers outlive a mount on purpose.
  ipc.invoked.length = 0;
  fixture.detectChanges();
  return { fixture };
}

/** Mounted with the log tab open and the raw view already showing: where the raw tests start. */
async function mountShowingRaw() {
  const { fixture } = mount({ state: "done" });
  // The `*transloco` root does not paint on the first synchronous tick, so
  // the tab and its views have to be awaited into existence before use.
  await fixture.whenStable();
  fixture.detectChanges();
  fixture.componentInstance.panel.set("log");
  fixture.detectChanges();
  fixture.nativeElement.querySelector("[data-testid=side-view-raw]")!.click();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe("Side", () => {
  it("says the book it is about", async () => {
    const { fixture } = mount();
    // The catalogue loads through a promise even though it is bundled, so the
    // `*transloco` root does not paint on the first synchronous tick.
    await fixture.whenStable();
    fixture.detectChanges();

    const side = fixture.nativeElement.querySelector("[data-testid=side]");
    expect(side.textContent).toContain("A Book");
    expect(side.textContent).toContain("An Author");
  });

  it("offers the description to read, and says when there is none", async () => {
    const { fixture } = mount({ ...detail, description: "Un manuale di Angular." });
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.nativeElement.querySelector("[data-testid=side-description]").click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=detail]").textContent)
      .toContain("Un manuale di Angular.");

    const { fixture: without } = mount();
    await without.whenStable();
    without.detectChanges();
    expect(without.nativeElement.querySelector("[data-testid=side-description]")).toBeNull();
  });

  it("offers one act, the one the machine would accept", async () => {
    const { fixture } = mount({ ...detail, actions: ["PAUSE"] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=side-action]").textContent)
      .toContain(it_IT.library.pause);
  });

  it("keeps deleting quiet, and asks before doing it", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();
    const remove = fixture.nativeElement.querySelector("[data-testid=side-delete]");
    expect(remove.className).not.toContain("btn-error");
    expect(remove.getAttribute("aria-label")).toBe(it_IT.library.delete);
  });

  /**
   * The duration is built from the catalogue, not from `m`/`s` written into
   * the code: a language that spells its minutes differently changes only
   * the two strings below.
   */
  it("spells the run's duration from the catalogue, not from letters in the code", async () => {
    const { fixture } = mount({
      ...detail, runStartedAt: "2026-08-30T09:00:00.000Z", runEndedAt: "2026-08-30T09:01:05.000Z",
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const withMinutes = it_IT.project.duration.minutes.replace("{{minutes}}", "1").replace("{{seconds}}", "05");
    expect(fixture.nativeElement.querySelector("[data-testid=side-meta]").textContent).toContain(withMinutes);

    const { fixture: brief } = mount({
      ...detail, runStartedAt: "2026-08-30T09:00:00.000Z", runEndedAt: "2026-08-30T09:00:07.000Z",
    });
    await brief.whenStable();
    brief.detectChanges();

    const secondsOnly = it_IT.project.duration.seconds.replace("{{seconds}}", "7");
    expect(brief.nativeElement.querySelector("[data-testid=side-meta]").textContent).toContain(secondsOnly);
  });

  /**
   * Production break: the download outranking `COMPOSE` in `primary()` left
   * a finished book with no way to compose it again. `done` is not final.
   */
  it("keeps composing reachable beside the download, once there is one", async () => {
    const { fixture } = mount({
      ...detail, state: "done", actions: ["COMPOSE"], outputPath: "/tmp/book.epub",
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=side-download]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=project-compose]")).not.toBeNull();
  });

  it("offers only the download when the machine has nothing left to retry", async () => {
    const { fixture } = mount({
      ...detail, state: "done", actions: [], outputPath: "/tmp/book.epub",
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=side-download]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=project-compose]")).toBeNull();
  });

  it("reads all five phases and lets the log take the panel's place", async () => {
    const { fixture } = mount({
      ...detail,
      state: "running",
      phases: [
        {
          phase: "analyze", state: "done",
          startedAt: "2026-08-30T09:00:00.000Z", endedAt: "2026-08-30T09:01:05.000Z",
          done: null, total: null, info: null,
        },
        detail.phases[1]!,
        detail.phases[2]!,
        { ...detail.phases[3]!, state: "running", done: 3, total: 10 },
        detail.phases[4]!,
      ],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll("[data-testid^=side-phase-]")).toHaveLength(5);
    expect(fixture.nativeElement.querySelector("[data-testid=side-phase-analyze]").textContent)
      .toContain("1m 05s");
    expect(fixture.nativeElement.querySelector("[data-testid=side-phase-translate]").textContent)
      .toContain("3 / 10");

    fixture.nativeElement.querySelector("[data-testid=side-tab-log]").click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=side-panel-progress]")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=side-panel-log]")).not.toBeNull();
  });

  it("tells the run's story: phases, degradations, and how each ended", async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [Side],
      providers: [
        ...provideI18n("it"),
        { provide: IpcService, useValue: {
          invoke: () => Promise.resolve<LogLine[]>([
            {
              at: "2026-08-30T09:02:00.000Z", kind: "state", code: "phase.analyze.done",
              severity: "info", info: { durationSeconds: 65 },
            },
            {
              at: "2026-08-30T09:03:00.000Z", kind: "event", code: "chunk-exhausted",
              severity: "warning", info: null,
            },
          ]),
          on: () => () => {},
        } },
      ],
    });
    const fixture = TestBed.createComponent(Side);
    fixture.componentRef.setInput("project", detail);
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector("[data-testid=side-tab-log]").click();
    await fixture.whenStable();
    fixture.detectChanges();

    const lines = fixture.nativeElement.querySelectorAll(".side__log-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain(it_IT.phase.analyze);
    expect(lines[0].textContent).toContain("1m 05s");
    expect(lines[1].textContent).toContain(it_IT.codes["chunk-exhausted"]);
    expect(lines[1].className).toContain("side__log-line--warning");
  });

  /**
   * The retry line was the one the Registro was missing. It is useless without
   * its numbers, and `phrase()` used to translate without passing any.
   */
  it("fills in the numbers of a retry line", async () => {
    const { fixture } = mount({ state: "running" });
    // The catalogue arrives through a promise even though it is bundled, so
    // the sentence is not there to ask for on the first synchronous tick.
    await fixture.whenStable();
    fixture.detectChanges();
    const spoken = fixture.componentInstance.phrase({
      at: new Date().toISOString(), kind: "event", code: "provider-retry", severity: "warning",
      info: { attempt: 2, max: 5, seconds: 4, reason: "PROVIDER_RATE_LIMITED" },
    });

    expect(spoken).toContain("2");
    expect(spoken).toContain("5");
    expect(spoken).not.toContain("{{");
  });

  it("offers the raw log beside the curated one, and asks for it only when shown", async () => {
    const { fixture } = mount({ state: "done" });
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.componentInstance.panel.set("log");
    fixture.detectChanges();

    expect(ipc.invoked).not.toContain("run.diagnostics");

    fixture.nativeElement.querySelector("[data-testid=side-view-raw]").click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(ipc.invoked).toContain("run.diagnostics");
    expect(fixture.nativeElement.querySelector("[data-testid=side-raw]")).toBeTruthy();
  });

  it("hides debug lines until asked", async () => {
    ipc.answer("run.diagnostics", {
      lines: [
        JSON.stringify({ at: "2026-09-01T10:00:00Z", level: "debug", code: "call-finished" }),
        JSON.stringify({ at: "2026-09-01T10:00:01Z", level: "warn", code: "provider-retry" }),
      ],
      path: "/w/logs",
    });

    const fixture = await mountShowingRaw();
    expect(fixture.nativeElement.querySelector("[data-testid=side-raw]").textContent)
      .not.toContain("call-finished");

    fixture.nativeElement.querySelector("[data-testid=side-raw-level-debug]").click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=side-raw]").textContent)
      .toContain("call-finished");
  });

  it("warns that synchronised reading will not survive the translation", async () => {
    const { fixture } = mount({ ...detail, hasOverlays: true });
    await fixture.whenStable();
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector("[data-testid=alert-overlays]");
    expect(card).not.toBeNull();
    expect(card.textContent).toContain(it_IT.overlays.warning);
  });

  /*
   * The catalogue holds a sentence for the codes it knows (`codes.*`); an
   * engine can fail with one it does not, and the fault class turns that
   * hole into a floor (`faults.*.body`) instead of a bare identifier. The
   * fallback is the case worth pinning, because it is the one nobody writes
   * on purpose.
   */
  it("says why the run stopped, and the class of a code it has no sentence for", async () => {
    const { fixture } = mount({
      state: "failed",
      phases: [phase("translate", "failed", { code: "provider-529" })],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=alert-stopped]").textContent)
      .toContain(it_IT.faults.defect.body);
  });

  /** A pause with a reason is a card of its own, and warning-coloured. */
  it("shows why a paused run stopped", async () => {
    const { fixture } = mount({
      state: "paused",
      phases: [phase("translate", "paused", { code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted" })],
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector("[data-testid=alert-stopped]");
    expect(card.textContent).toContain("Il credito del provider è esaurito.");
    expect(card.textContent).toContain("Ricarica");
    expect(card.className).toContain("warning");
  });

  it("shows a failed run in the danger tone", async () => {
    const { fixture } = mount({
      state: "failed",
      phases: [phase("compose", "failed", { code: "GATE_REFUSED", fault: "refused" })],
    });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=alert-stopped]").className)
      .toContain("danger");
  });

  it("says nothing when there is nothing to say", async () => {
    const { fixture } = mount({ ...detail, description: "C'è." });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll("[data-testid^=alert-]")).toHaveLength(0);
  });

  it("offers the edit, and refuses it only while the engine is alive", async () => {
    // Paused is exactly when someone changes their mind about the model, so
    // the button stays on. What protects the work is the confirmation inside
    // the dialog, not a button that is off.
    const paused = mount({ ...detail, state: "paused" });
    await paused.fixture.whenStable();
    paused.fixture.detectChanges();
    expect(paused.fixture.nativeElement.querySelector("[data-testid=side-edit]")
      .hasAttribute("disabled")).toBe(false);

    const running = mount({ ...detail, state: "running" });
    await running.fixture.whenStable();
    running.fixture.detectChanges();
    expect(running.fixture.nativeElement.querySelector("[data-testid=side-edit]")
      .hasAttribute("disabled")).toBe(true);
  });
});
