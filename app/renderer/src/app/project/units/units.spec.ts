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

function bridge() {
  return vi.fn(async (channel: string, _payload?: unknown) =>
    channel === "units.list" ? { units: rows, total: 2 } : undefined);
}

function mount(invoke = bridge()) {
  TestBed.configureTestingModule({
    imports: [Units],
    providers: [
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: () => () => {} } },
    ],
  });
  const fixture = TestBed.createComponent(Units);
  fixture.componentRef.setInput("projectId", "p1");
  return { fixture, invoke };
}

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
    const { fixture, invoke } = mount();
    await fixture.whenStable();
    fixture.componentInstance.more();
    await fixture.whenStable();
    expect(lastQuery(invoke)).toMatchObject({ offset: 50 });

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
