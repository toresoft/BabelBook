import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../../locales/it.json";
import type { Report } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { provideI18n } from "../../core/i18n";
import { ReportView } from "./report";

const base: Report = {
  status: "complete",
  units: { total: 10, translated: 10, fellBack: 0, identical: 0, notTranslated: {} },
  identicalWarning: false,
  degradations: [],
  declarations: [],
  invariants: [{ id: "I1", name: "same documents", ok: true, details: [] }],
  epubcheck: { ran: true, introduced: [] },
  layout: { book: "reflowable", prePaginated: 0 },
  overlaysRemoved: { overlays: 0, audio: 0 },
  terms: { active: 0, adherence: null },
  cost: { tokensIn: 1000, tokensOut: 500, amount: null },
  outputPath: "/w/projects/p1/output/a.it.epub",
};

function bridge(report: Report | null = base, answers: Record<string, unknown> = {}) {
  return vi.fn(async (channel: string, _payload?: unknown) =>
    channel in answers ? answers[channel]
      : channel === "report.get" ? report
      : undefined);
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
    imports: [ReportView],
    providers: [
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: events.on } },
    ],
  });
  const fixture = TestBed.createComponent(ReportView);
  fixture.componentRef.setInput("projectId", "p1");
  return { fixture, invoke, events };
}

async function render(report: Report | null): Promise<string> {
  const { fixture } = mount(bridge(report));
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement.textContent as string;
}

const catalogue = it_IT as unknown as {
  report: Record<string, string>;
  codes: Record<string, string>;
};

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([name]) => name === channel);

describe("ReportView", () => {
  /*
   * A report read while a run is still moving is a report of a moment; it is
   * asked again whenever the run says something changed.
   */
  it("asks again when the run says this project changed", async () => {
    const { fixture, invoke, events } = mount();
    await fixture.whenStable();
    const before = invoke.mock.calls.filter(([name]) => name === "report.get").length;

    events.emit("project.changed", { id: "p1" });
    await fixture.whenStable();

    expect(invoke.mock.calls.filter(([name]) => name === "report.get").length).toBe(before + 1);
  });

  it("turns a code into a sentence from the catalogue", async () => {
    const text = await render({
      ...base,
      status: "incomplete",
      degradations: [{ code: "unit-fell-back", severity: "degradation", count: 3, samples: [] }],
    });

    // The report carries codes precisely so two different books that went
    // wrong the same way say the same thing.
    expect(text).toContain(catalogue.codes["unit-fell-back"]);
    expect(text).not.toContain("unit-fell-back");
  });

  it("keeps declarations out of the degradations list", async () => {
    const text = await render({
      ...base,
      declarations: [{ code: "author-translate-no", severity: "info", count: 4, samples: [] }],
    });

    expect(text).toContain(catalogue.report["noDegradations"]);
    expect(text).toContain(catalogue.codes["author-translate-no"]);
  });

  it("never presents an EPUBCheck that did not run as one that passed", async () => {
    const notRun = await render({
      ...base, epubcheck: { ran: false, reason: "no-jar", introduced: [] },
    });

    expect(notRun).toContain(catalogue.report["epubcheckNotRun"]);
    expect(notRun).not.toContain(catalogue.report["epubcheckClean"]);
  });

  it("says the book was never composed rather than showing an empty pass", async () => {
    const text = await render({ ...base, invariants: [], outputPath: null });

    expect(text).toContain(catalogue.report["notComposed"]);
  });

  it("names the invariants that failed, with what differs", async () => {
    const text = await render({
      ...base,
      status: "failed",
      invariants: [
        { id: "I1", name: "same documents", ok: true, details: [] },
        { id: "I17", name: "no unit vanished", ok: false, details: ["c1.xhtml#1"] },
      ],
    });

    // An invariant that only says "failed" costs an investigation.
    expect(text).toContain("c1.xhtml#1");
  });

  it("warns when too many translations came back identical", async () => {
    expect(await render({ ...base, identicalWarning: true }))
      .toContain(catalogue.report["identicalWarning"]);
  });

  it("hands the produced file to the desktop by the path it was given", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    await fixture.componentInstance.open(base.outputPath!);

    expect(invoke.mock.calls.filter(([channel]) => channel === "file.open")[0]![1])
      .toMatchObject({ path: base.outputPath });
  });

  it("offers nothing to open when no file was produced", async () => {
    expect(await render({ ...base, outputPath: null }))
      .not.toContain(catalogue.report["openEpub"]);
  });

  it("saves the translated book where it is asked to, and leaves the project alone", async () => {
    const invoke = bridge(base, { "ui.chooseSave": "/home/somebody/book.it.epub" });
    const { fixture } = mount(invoke);
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector("[data-testid=export-epub]")!.click();
    await fixture.whenStable();

    expect(calls(invoke, "ui.chooseSave")[0]![1]).toMatchObject({ kind: "epub" });
    expect(calls(invoke, "project.export")[0]![1]).toMatchObject({
      to: "/home/somebody/book.it.epub",
      // The file is named, not guessed: a retranslation leaves two EPUBs in
      // the folder, and the copy must be of the book this report shows.
      from: "a.it.epub",
    });
    // Exporting is not a branch of deleting: nothing is destroyed by saving.
    expect(calls(invoke, "project.delete")).toHaveLength(0);
  });

  it("says a project was never run instead of showing an empty report", async () => {
    expect(await render(null)).toContain(catalogue.report["neverRun"]);
  });
});
