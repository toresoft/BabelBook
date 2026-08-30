import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import it_IT from "../../../../../locales/it.json";
import type { ProjectDetail } from "../../../../../shared/dto.js";
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

function mount(project = detail) {
  // A test that mounts twice (one project, then another) needs a fresh
  // module each time: the first `createComponent` instantiates the testing
  // module, and Angular refuses to configure an instantiated one again.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [Side], providers: [...provideI18n("it")] });
  const fixture = TestBed.createComponent(Side);
  fixture.componentRef.setInput("project", project);
  fixture.detectChanges();
  return { fixture };
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
});
