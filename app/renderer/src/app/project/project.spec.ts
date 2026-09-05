import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../locales/it.json";
import type { ProjectDetail } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { provideI18n } from "../core/i18n";
import { Project } from "./project";

const detail: ProjectDetail = {
  id: "p1",
  title: "A Book",
  author: "An Author",
  coverPath: null,
  description: "Second volume",
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

function bridge(project: ProjectDetail | null = detail) {
  return vi.fn(async (channel: string, _payload?: unknown) => {
    if (channel === "project.get") return project;
    if (channel === "terms.list" || channel === "glossaries.list") return [];
    if (channel === "exclusions.list") return [];
    if (channel === "units.list") return { units: [], total: 0 };
    if (channel === "report.get") return null;
    return undefined;
  });
}

/** The event side of the bridge, which `mount`'s stub does not have. */
function events() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return () => {};
    },
    emit: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
}

function mount(invoke = bridge(), bus = events()) {
  TestBed.configureTestingModule({
    imports: [Project],
    providers: [
      provideRouter([]),
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: bus.on } },
    ],
  });
  const fixture = TestBed.createComponent(Project);
  fixture.componentRef.setInput("id", "p1");
  return { fixture, invoke, bus };
}

const catalogue = it_IT as unknown as {
  library: Record<string, string>;
  state: Record<string, string>;
  phaseCounts: Record<string, string>;
  project: Record<string, unknown>;
};

describe("Project", () => {
  it("takes the available buttons from the machine, not from the state name", async () => {
    const { fixture } = mount(bridge({ ...detail, state: "paused", actions: ["RESUME"] }));
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(catalogue.library["resume"]);
    // `paused` also looks like a state where pausing might apply; the machine
    // says otherwise, and the machine is what decides.
    expect(text).not.toContain(catalogue.library["pause"]);
  });

  /**
   * A book composed wrong stayed composed wrong: `done` allowed nothing, so
   * the screen showed no button and the only way out was to translate the
   * whole book again. The way back is still there — it is just no longer
   * spelled "recompose". The screen asks for the book, and the main process
   * decides whether one has to be written first.
   */
  it("asks for the book, and never for the step that writes it", async () => {
    const { fixture, invoke } = mount(bridge({
      ...detail, state: "done", actions: ["COMPOSE"], outputPath: null,
    }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=project-compose]")).toBeNull();

    const download = fixture.nativeElement.querySelector("[data-testid=side-download]");
    expect(download).not.toBeNull();
    download.click();
    await fixture.whenStable();

    expect(invoke).toHaveBeenCalledWith("project.download", { projectId: "p1" });
    expect(invoke).not.toHaveBeenCalledWith("run.compose", { projectId: "p1" });
  });

  /**
   * The wait is the reason this is worth a state at all: composing rewrites
   * the whole EPUB and runs EPUBCheck over it, and a button that looks idle
   * for those seconds gets pressed again.
   */
  it("says the book is being composed while it waits for it", async () => {
    let release = (): void => {};
    const held = new Promise<undefined>((resolve) => { release = () => resolve(undefined); });
    const answers = bridge({
      ...detail, state: "done", actions: ["COMPOSE"], outputPath: "/tmp/book.epub",
    });
    const { fixture } = mount(vi.fn(async (channel: string, payload?: unknown) =>
      channel === "project.download" ? held : answers(channel, payload)));
    await fixture.whenStable();
    fixture.detectChanges();

    const download = fixture.nativeElement.querySelector("[data-testid=side-download]");
    download.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const busy = fixture.nativeElement.querySelector("[data-testid=side-download]");
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toContain(catalogue.state["composing"]);

    release();
    await fixture.whenStable();
  });

  it("offers nothing when the machine allows nothing", async () => {
    const { fixture } = mount(bridge({ ...detail, state: "composing", actions: [] }));
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain(catalogue.library["translate"]);
    expect(text).not.toContain(catalogue.library["pause"]);
    expect(text).not.toContain(catalogue.library["resume"]);
  });

  it("opens on the gate that is waiting, because that is where the user is needed", async () => {
    const { fixture } = mount(bridge({ ...detail, state: "waiting-terms", actions: ["TERMS_APPROVED"] }));
    await fixture.whenStable();

    expect(fixture.componentInstance.tab()).toBe("terms");
  });

  it("opens on the exclusions when that is the gate", async () => {
    const { fixture } = mount(bridge({ ...detail, state: "waiting-code", actions: ["CODE_REVIEWED"] }));
    await fixture.whenStable();

    expect(fixture.componentInstance.tab()).toBe("exclusions");
  });

  it("opens on the terms when no gate is open, and offers no overview to open", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.componentInstance.tab()).toBe("terms");
    expect(fixture.nativeElement.querySelector("[data-testid=tab-overview]")).toBeNull();
  });

  it("warns about a fixed layout and about overlays, on the book's own screen", async () => {
    const { fixture } = mount(bridge({ ...detail, layout: "pre-paginated", hasOverlays: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    // The cards the column carries: what the overview used to say, said where
    // the work happens instead of a tab of its own.
    expect(fixture.nativeElement.querySelector("[data-testid=alert-layout]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=alert-overlays]")).not.toBeNull();
  });

  it("says the project is gone rather than rendering an empty screen", async () => {
    const { fixture } = mount(bridge(null));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=project-missing]")).not.toBeNull();
  });

  it("writes no sentence of its own: every label comes from the catalogue", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain((catalogue.project["tabs"] as Record<string, string>)["terms"]);
    expect(text).not.toContain("project.");
  });

  it("shows the phase and its own counter while a run is going", async () => {
    const { fixture, bus } = mount(bridge({ ...detail, state: "running" }));
    await fixture.whenStable();

    bus.emit("run.progress", { projectId: "p1", phase: "code-index", done: 7, total: 298 });
    fixture.detectChanges();

    const bar = fixture.nativeElement.querySelector("[data-testid=phase-progress]");
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("value")).toBe("2");
    expect(fixture.nativeElement.querySelector("[data-testid=phase-counts]").textContent)
      .toContain("7");
  });

  /*
   * The column's phase bar reads `ProjectDetail.phases`, which the last
   * `project.get` filled: without this, it shows the counts the run started
   * with and never moves again until a state change reloads the book.
   */
  it("feeds the column's own phase bar from the live counts, not the last reload", async () => {
    const running = {
      ...detail,
      state: "running",
      phases: detail.phases.map((entry) => entry.phase === "translate"
        ? { ...entry, state: "running" as const, done: 0, total: 10 }
        : entry),
    };
    const { fixture, bus } = mount(bridge(running));
    await fixture.whenStable();
    fixture.detectChanges();

    bus.emit("run.progress", { projectId: "p1", phase: "translate", done: 7, total: 10 });
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector("[data-testid=side-phase-translate]");
    expect(row.textContent).toContain("7 / 10");
    expect(row.querySelector("progress").getAttribute("value")).toBe("7");
  });

  /**
   * Production break: both bars were fed the same two numbers, so the screen
   * asked one question twice. The upper one is where the run has got to
   * between its phases; the lower one is how far this phase has got.
   */
  it("asks two questions with two bars: which phase, and how far into it", async () => {
    const { fixture, bus } = mount(bridge({ ...detail, state: "running" }));
    await fixture.whenStable();

    bus.emit("run.phase", { projectId: "p1", phase: "code-index" });
    bus.emit("run.progress", { projectId: "p1", phase: "code-index", done: 7, total: 298 });
    fixture.detectChanges();

    // Third of the five phases the run declares.
    expect(fixture.nativeElement.querySelector("[data-testid=phase-step]").getAttribute("value"))
      .toBe("60");
    expect(fixture.nativeElement.querySelector("[data-testid=phase-progress]").getAttribute("value"))
      .toBe("2");
  });

  /**
   * Production break: a phase counter written into the book's own count made
   * the book jump to 7 of 298 while nothing of it had been translated.
   */
  it("moves the book's own count only in the phase that translates it", async () => {
    const { fixture, bus } = mount(bridge({ ...detail, state: "running" }));
    await fixture.whenStable();

    bus.emit("run.phase", { projectId: "p1", phase: "code-index" });
    bus.emit("run.progress", { projectId: "p1", phase: "code-index", done: 7, total: 298 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=book-counts]").textContent)
      .toContain("0");
    expect(fixture.nativeElement.querySelector("[data-testid=book-counts]").textContent)
      .toContain("10");

    bus.emit("run.phase", { projectId: "p1", phase: "translate" });
    bus.emit("run.progress", { projectId: "p1", phase: "translate", done: 4, total: 10 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=book-counts]").textContent)
      .toContain("4");
  });

  /**
   * The counter belongs to the phase that reported it. Left under the next
   * phase's name it would claim a progress nobody measured.
   */
  it("does not carry a phase's counter over into the next phase", async () => {
    const { fixture, bus } = mount(bridge({ ...detail, state: "running" }));
    await fixture.whenStable();

    bus.emit("run.phase", { projectId: "p1", phase: "code-index" });
    bus.emit("run.progress", { projectId: "p1", phase: "code-index", done: 7, total: 298 });
    fixture.detectChanges();

    bus.emit("run.phase", { projectId: "p1", phase: "translate" });
    fixture.detectChanges();

    const bar = fixture.nativeElement.querySelector("[data-testid=phase-progress]");
    expect(bar.getAttribute("value")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=phase-counts]")).toBeNull();
  });

  /** A phase counts what its own phase counts: batches are not units. */
  it("names what the phase is counting, and does not call batches units", async () => {
    const { fixture, bus } = mount(bridge({ ...detail, state: "running" }));
    await fixture.whenStable();

    bus.emit("run.phase", { projectId: "p1", phase: "code-index" });
    bus.emit("run.progress", { projectId: "p1", phase: "code-index", done: 7, total: 298 });
    fixture.detectChanges();

    const counts = fixture.nativeElement.querySelector("[data-testid=phase-counts]").textContent as string;
    expect(counts).toContain(catalogue.phaseCounts["code-index"].replace("{{done}}", "7").replace("{{total}}", "298"));
  });

  /**
   * In the translating phase the phase's counter and the book's are the same
   * sentence, word for word. It is printed once, under the bar that owns it.
   */
  it("does not print the same count twice while translating", async () => {
    const { fixture, bus } = mount(bridge({ ...detail, state: "running" }));
    await fixture.whenStable();

    bus.emit("run.phase", { projectId: "p1", phase: "translate" });
    bus.emit("run.progress", { projectId: "p1", phase: "translate", done: 4, total: 10 });
    fixture.detectChanges();

    // The bar stays: it is the longest phase, and a phase with no bar reads
    // as a phase that is not moving.
    expect(fixture.nativeElement.querySelector("[data-testid=phase-progress]").getAttribute("value"))
      .toBe("40");
    expect(fixture.nativeElement.querySelector("[data-testid=phase-counts]")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=book-counts]").textContent)
      .toContain("4");
  });

  /** With no run going, the one bar on the screen is the book's own. */
  it("shows the book's bar at rest and the run's bars while it runs", async () => {
    const { fixture, bus } = mount(bridge({ ...detail, state: "running" }));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=book-progress]")).not.toBeNull();

    bus.emit("run.phase", { projectId: "p1", phase: "translate" });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=book-progress]")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=phase-step]")).not.toBeNull();
  });

  /**
   * A phase bar left on screen after the run is a lie with a date on it.
   */
  it("drops the phase bar when the run ends", async () => {
    const { fixture, bus } = mount(bridge({ ...detail, state: "done" }));
    await fixture.whenStable();

    bus.emit("run.phase", { projectId: "p1", phase: "translate" });
    bus.emit("run.progress", { projectId: "p1", phase: "translate", done: 3, total: 9 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=phase-progress]")).not.toBeNull();

    bus.emit("project.changed", { id: "p1" });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=phase-progress]")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=phase-step]")).toBeNull();
  });

  /**
   * `run.usage` overrides the database's own count only while the run is
   * alive. A reload that finds the run over must bring the database's count
   * back — the live signal is a loan, not a replacement.
   */
  it("shows the live spend while running, and the database's own again once reloaded as not running", async () => {
    let current: ProjectDetail = {
      ...detail, state: "running", tokens: { in: 100, out: 50, reasoning: 1 },
    };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "project.get") return current;
      if (channel === "terms.list" || channel === "glossaries.list") return [];
      if (channel === "exclusions.list") return [];
      if (channel === "units.list") return { units: [], total: 0 };
      if (channel === "report.get") return null;
      return undefined;
    });
    const { fixture, bus } = mount(invoke);
    await fixture.whenStable();
    fixture.detectChanges();

    // The column's token row is where the spend is read now.
    const tokens = () => fixture.nativeElement.querySelector("[data-testid=side-tokens]").textContent as string;
    expect(tokens()).toContain("100");

    bus.emit("run.usage", { projectId: "p1", tokensIn: 999, tokensOut: 888, reasoningTokens: 3 });
    fixture.detectChanges();
    expect(tokens()).toContain("999");
    expect(tokens()).toContain("888");
    expect(tokens()).not.toContain("100");

    current = { ...current, state: "done" };
    bus.emit("project.changed", { id: "p1" });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(tokens()).toContain("100");
    expect(tokens()).not.toContain("999");
  });

  it("names the book in the trail, not only the way back", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const crumbs = fixture.nativeElement.querySelector("[data-testid=project-crumbs]");
    expect(crumbs.textContent).toContain(it_IT.app.library);
    expect(crumbs.textContent).toContain("A Book");

    // The way back is a button with a name for whoever reads instead of looks.
    const back = fixture.nativeElement.querySelector("[data-testid=project-back]");
    expect(back.getAttribute("aria-label")).toBe(it_IT.project.back);
  });
});
