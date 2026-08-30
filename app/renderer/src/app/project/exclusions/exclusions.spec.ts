import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../../locales/it.json";
import type { ExclusionGroup } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { provideI18n } from "../../core/i18n";
import { Exclusions } from "./exclusions";

const groups: ExclusionGroup[] = [
  {
    state: "code",
    reason: "css-code-surface",
    doc: "c1.xhtml",
    units: [
      { unitId: "c1.xhtml#1", ordinal: 1, text: "gem install foo", forced: false },
      { unitId: "c1.xhtml#2", ordinal: 2, text: "The src/ directory holds the sources", forced: false },
    ],
  },
  {
    state: "translate-no",
    reason: null,
    doc: "c1.xhtml",
    units: [{ unitId: "c1.xhtml#3", ordinal: 3, text: "Acme Corp", forced: false }],
  },
];

function bridge(answers: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (channel: string, _payload?: unknown) => {
    if (channel in answers) return answers[channel];
    if (channel === "exclusions.list") return groups;
    return undefined;
  });
}

/** The main process's events, as a thing a test can fire. */
function bus() {
  const listeners: Record<string, Array<(payload: unknown) => void>> = {};
  return {
    on: (channel: string, listener: (payload: unknown) => void) => {
      (listeners[channel] ??= []).push(listener);
      return () => { listeners[channel] = (listeners[channel] ?? []).filter((l) => l !== listener); };
    },
    emit: (channel: string, payload: unknown) => {
      for (const listener of listeners[channel] ?? []) listener(payload);
    },
  };
}

function mount(invoke = bridge(), events = bus()) {
  TestBed.configureTestingModule({
    imports: [Exclusions],
    providers: [
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: events.on } },
    ],
  });
  const fixture = TestBed.createComponent(Exclusions);
  fixture.componentRef.setInput("projectId", "p1");
  return { fixture, invoke, events };
}

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([name]) => name === channel);

describe("Exclusions", () => {
  /*
   * The code index settles these while the gate may already be on screen: the
   * blocks the reader is judging must be the ones the index decided, not the
   * ones the extractor guessed.
   */
  it("asks again when the run says this project changed", async () => {
    const { fixture, invoke, events } = mount();
    await fixture.whenStable();
    const before = invoke.mock.calls.filter(([name]) => name === "exclusions.list").length;

    events.emit("project.changed", { id: "p1" });
    await fixture.whenStable();

    expect(invoke.mock.calls.filter(([name]) => name === "exclusions.list").length).toBe(before + 1);
  });

  it("shows the groups with the block text, so a verdict can be judged", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("gem install foo");
    expect(text).toContain("Acme Corp");
  });

  it("opens a block in full, and decides it from there", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector("[data-testid='unit-c1.xhtml#2']").click();
    fixture.detectChanges();

    // The table clamps a listing to two lines; the dialog is where the whole
    // of it is read, and where the verdict can be given knowing it.
    const detail = fixture.nativeElement.querySelector("[data-testid=detail]");
    expect(detail.textContent).toContain("The src/ directory holds the sources");

    detail.querySelector("[data-testid='detail-free-c1.xhtml#2']").click();
    fixture.detectChanges();

    // Deciding closes it: the decision was the reason it was opened.
    expect(fixture.nativeElement.querySelector("[data-testid=detail]")).toBeNull();
    expect(fixture.componentInstance.changes()).toBe(1);

    await fixture.componentInstance.save();
    expect((calls(invoke, "exclusions.force")[0]![1] as { changes: unknown[] }).changes)
      .toEqual([{ unitId: "c1.xhtml#2", state: "translate" }]);
  });

  it("sends every forced state in one call, not one call per block", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    fixture.componentInstance.force("c1.xhtml#1", "translate");
    fixture.componentInstance.force("c1.xhtml#3", "translate");
    await fixture.componentInstance.save();

    const forced = calls(invoke, "exclusions.force");
    expect(forced).toHaveLength(1);
    expect(forced[0]![1] as { changes: unknown[] }).toMatchObject({
      changes: [{ unitId: "c1.xhtml#1" }, { unitId: "c1.xhtml#3" }],
    });
  });

  it("saves nothing when nothing was changed", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    await fixture.componentInstance.save();

    expect(calls(invoke, "exclusions.force")).toHaveLength(0);
  });

  it("lets a staged verdict be taken back before it is saved", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    fixture.componentInstance.force("c1.xhtml#1", "translate");
    fixture.componentInstance.unstage("c1.xhtml#1");
    await fixture.componentInstance.save();

    expect(calls(invoke, "exclusions.force")).toHaveLength(0);
  });

  it("unblocks the machine only after the verdicts are stored", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();
    fixture.componentInstance.force("c1.xhtml#1", "translate");

    await fixture.componentInstance.approveGate();

    const order = invoke.mock.calls.map(([channel]) => channel);
    expect(order.indexOf("exclusions.force")).toBeLessThan(order.indexOf("run.approve"));
    expect(calls(invoke, "run.approve")[0]![1]).toMatchObject({ gate: "code" });
  });

  it("writes no sentence of its own: every label comes from the catalogue", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    const catalogue = it_IT as unknown as { exclusions: Record<string, string> };
    expect(text).toContain(catalogue.exclusions["free"]);
    expect(text).not.toContain("exclusions.");
    expect(text).not.toContain("unitState.");
  });
});
