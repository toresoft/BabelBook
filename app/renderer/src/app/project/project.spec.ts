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
  actions: ["START"],
  tokens: { in: 0, out: 0, reasoning: 0 },
  cost: null,
  createdAt: "2026-08-24",
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

  it("stays on the overview when no gate is open", async () => {
    const { fixture } = mount();
    await fixture.whenStable();

    expect(fixture.componentInstance.tab()).toBe("overview");
  });

  it("warns about a fixed layout and about overlays, on the book's own screen", async () => {
    const { fixture } = mount(bridge({ ...detail, layout: "pre-paginated", hasOverlays: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=layout-warning]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=overlay-warning]")).not.toBeNull();
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
    expect(text).toContain((catalogue.project["tabs"] as Record<string, string>)["overview"]);
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

  /**
   * A phase bar left on screen after the run is a lie with a date on it.
   */
  it("drops the phase bar when the run ends", async () => {
    const { fixture, bus } = mount(bridge({ ...detail, state: "done" }));
    await fixture.whenStable();

    bus.emit("run.progress", { projectId: "p1", phase: "translate", done: 3, total: 9 });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=phase-progress]")).not.toBeNull();

    bus.emit("project.changed", { id: "p1" });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=phase-progress]")).toBeNull();
  });
});
