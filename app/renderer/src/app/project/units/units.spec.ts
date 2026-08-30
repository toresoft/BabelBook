import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../../locales/it.json";
import type { UnitRow } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { provideI18n } from "../../core/i18n";
import { Units } from "./units";

const rows: UnitRow[] = [
  {
    unitId: "c1.xhtml#1", doc: "c1.xhtml", ordinal: 1, state: "translate", forced: false,
    reason: null, source: "The road to Rivendell",
    translation: "La strada per Gran Burrone", outcome: "translated",
  },
  {
    unitId: "c1.xhtml#2", doc: "c1.xhtml", ordinal: 2, state: "code", forced: true,
    reason: "css-code-surface", source: "gem install foo", translation: null, outcome: null,
  },
];

function bridge(total = 2) {
  return vi.fn(async (channel: string, _payload?: unknown) =>
    channel === "units.list" ? { units: rows, total } : undefined);
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
    imports: [Units],
    providers: [
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: events.on } },
    ],
  });
  const fixture = TestBed.createComponent(Units);
  fixture.componentRef.setInput("projectId", "p1");
  return { fixture, invoke, events };
}

const calls = (invoke: ReturnType<typeof bridge>) =>
  invoke.mock.calls.filter(([name]) => name === "units.list");

const lastQuery = (invoke: ReturnType<typeof bridge>) =>
  invoke.mock.calls.filter(([name]) => name === "units.list").at(-1)![1] as Record<string, unknown>;

describe("Units", () => {
  it("puts the source beside its translation", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("The road to Rivendell");
    expect(text).toContain("La strada per Gran Burrone");
  });

  it("says which column is the source and which the translation", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    // Two prose columns with nothing over them answer nothing: the reader
    // should never have to guess which side is whose language.
    const columns = fixture.nativeElement.querySelector("[data-testid=unit-columns]");
    expect(columns).not.toBeNull();
    const catalogue = it_IT as unknown as { units: Record<string, string> };
    expect(columns.textContent).toContain(catalogue.units["sourceColumn"]);
    expect(columns.textContent).toContain(catalogue.units["translationColumn"]);
  });

  /*
   * Production break: a run wrote translations while this tab was open and the
   * table went on saying "not yet translated" until the reader thought to
   * change a filter. The tab a book is checked with cannot be the last to know.
   */
  it("asks again when the run reports progress on this book", async () => {
    const { fixture, invoke, events } = mount();
    await fixture.whenStable();
    const before = calls(invoke).length;

    events.emit("run.progress", { projectId: "p1", phase: "translate", done: 3, total: 9 });
    await fixture.whenStable();

    expect(calls(invoke).length).toBe(before + 1);
  });

  it("ignores a run on another book", async () => {
    const { fixture, invoke, events } = mount();
    await fixture.whenStable();
    const before = calls(invoke).length;

    events.emit("run.progress", { projectId: "p2", phase: "translate", done: 3, total: 9 });
    await fixture.whenStable();

    expect(calls(invoke).length).toBe(before);
  });

  it("answers the first message at once, and the storm that follows it once", async () => {
    const { fixture, invoke, events } = mount();
    await fixture.whenStable();
    const before = calls(invoke).length;

    for (let at = 0; at < 20; at++) {
      events.emit("run.progress", { projectId: "p1", phase: "translate", done: at, total: 20 });
    }
    await fixture.whenStable();

    // One query, not twenty: the rest are held for the end of the second.
    expect(calls(invoke).length).toBe(before + 1);
  });

  it("opens a row in full, and closes it again", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    // The table cuts a paragraph to three lines; this is where the whole of it
    // is read, beside its translation.
    expect(fixture.nativeElement.querySelector("[data-testid=detail]")).toBeNull();

    fixture.nativeElement.querySelector("[data-testid='row-c1.xhtml#1']").click();
    fixture.detectChanges();

    const detail = fixture.nativeElement.querySelector("[data-testid=detail]");
    expect(detail).not.toBeNull();
    expect(detail.textContent).toContain("The road to Rivendell");
    expect(detail.textContent).toContain("La strada per Gran Burrone");

    detail.querySelector("[data-testid=detail-close]").click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=detail]")).toBeNull();
  });

  it("keeps the pager off a single page", async () => {
    const { fixture } = mount(bridge(2));
    await fixture.whenStable();
    fixture.detectChanges();

    // Two disabled buttons under a list that ended are not navigation: they
    // are an admission that the list is short.
    expect(fixture.nativeElement.querySelector("[data-testid=units-back]")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=units-more]")).toBeNull();
  });

  it("shows the pager when there is more than one page", async () => {
    const { fixture } = mount(bridge(120));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=units-back]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=units-more]")).not.toBeNull();
  });

  it("counts under the title, and counts what the filters left", async () => {
    const { fixture } = mount(bridge(7));
    await fixture.whenStable();
    fixture.detectChanges();

    // The count is the subtitle of the list, where the revised design puts it;
    // it still answers the filters, because the number the store returns is
    // the number of rows the current question has.
    const subtitle = fixture.nativeElement.querySelector(".list__subtitle");
    expect(subtitle.textContent).toContain("7");
  });

  it("says a unit is untranslated rather than showing an empty column", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const catalogue = it_IT as unknown as { units: Record<string, string> };
    expect(fixture.nativeElement.textContent as string).toContain(catalogue.units["untranslated"]);
  });

  it("marks a state the user forced, so it is not mistaken for a deduction", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const catalogue = it_IT as unknown as { units: Record<string, string> };
    expect(fixture.nativeElement.textContent as string).toContain(catalogue.units["forced"]);
  });

  it("asks the main process to filter, instead of filtering a page it already has", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    fixture.componentInstance.onState("code");
    await fixture.whenStable();

    // Filtering in the window would only ever filter the current page, and
    // silently answer a question about the whole book with part of it.
    expect(lastQuery(invoke)).toMatchObject({ state: "code" });
  });

  it("searches through the main process too", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    fixture.componentInstance.onSearch("Rivendell");
    await fixture.whenStable();

    expect(lastQuery(invoke)).toMatchObject({ search: "Rivendell" });
  });

  it("returns to the first page when the question changes", async () => {
    // A book long enough to have a second page: the pager clamps to the last
    // one, so a list of two units has nowhere to go.
    const { fixture, invoke } = mount(bridge(120));
    await fixture.whenStable();
    fixture.componentInstance.goto(2);
    await fixture.whenStable();
    expect(lastQuery(invoke)).toMatchObject({ offset: 20 });

    fixture.componentInstance.onState("code");
    await fixture.whenStable();

    // Page four of a different question is nowhere.
    expect(lastQuery(invoke)).toMatchObject({ offset: 0 });
  });

  it("writes no sentence of its own: every label comes from the catalogue", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain("units.");
    expect(text).not.toContain("unitState.");
  });
});
