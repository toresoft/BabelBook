import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../locales/it.json";
import type { ProjectSummary } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { provideI18n } from "../core/i18n";
import { Library } from "./library";

const summary: ProjectSummary = {
  id: "p1", title: "A Book", coverPath: null, sourceLanguage: "en", targetLanguage: "it",
  state: "running", progress: { done: 3, total: 9 }, layout: "reflowable",
  createdAt: "2026-08-27T00:00:00.000Z", outputPath: null,
};

function bridge(answers: Record<string, unknown> = {}) {
  return vi.fn(async (channel: string, payload?: unknown) => {
    // What the test asked for wins over the defaults. The other way round, an
    // override of a channel that has a default is dropped in silence, and the
    // test passes while measuring the fixture instead of its own case.
    if (channel in answers) {
      const answer = answers[channel];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(payload) : answer;
    }
    if (channel === "projects.list") return [summary] as ProjectSummary[];
    if (channel === "providers.list") {
      return [{
        id: "pv1", name: "Acme", route: "acme", baseUrl: null, headers: {}, options: {},
        catalogId: null, catalogAt: null, hasKey: true,
        models: [{ id: "m1", displayName: "M1", contextWindow: null, priceIn: null,
                   priceOut: null, capabilities: null, reasoningLevel: null }],
      }];
    }
    return undefined;
  });
}

function mount(answers: Record<string, unknown> = {}) {
  const invoke = bridge(answers);
  TestBed.configureTestingModule({
    imports: [Library],
    providers: [
      provideRouter([]),
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: () => () => {} } },
    ],
  });
  const fixture = TestBed.createComponent(Library);
  return { fixture, invoke };
}

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([name]) => name === channel);

/**
 * The shelf, as a screen rather than a list of data.
 *
 * The primary act of the library is starting something new, a tile is read
 * title-first, and the state of a book is seen before it is read. These hold
 * the structure that carries those three facts.
 */
describe("Library", () => {
  it("offers New project as a primary button, not an underlined link", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const entry = fixture.nativeElement.querySelector("[data-testid=new-project]");
    expect(entry).not.toBeNull();
    expect(entry.className).toContain("btn-primary");
  });

  it("reads a tile top to bottom: title, then languages and state, then the progress", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const tile = fixture.nativeElement.querySelector("[data-testid=project-p1]");
    const all = [...tile.querySelectorAll("*")] as HTMLElement[];
    const at = (selector: string): number => all.indexOf(tile.querySelector(selector) as HTMLElement);

    for (const selector of [".tile__meta", ".tile__progress"]) {
      expect(tile.querySelector(selector), selector).not.toBeNull();
    }
    // The title is the first thing after the cover; the languages and the
    // state come next; the progress bar closes the reading.
    expect(at("h2")).toBeLessThan(at(".tile__meta"));
    expect(at(".tile__meta")).toBeLessThan(at(".tile__progress"));
  });

  it("tells the state at a glance, not as a grey word among the others", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const state = fixture.nativeElement.querySelector(".tile__state");
    expect(state).not.toBeNull();
    // The badge is the hook the tone needs: "failed" can carry another colour
    // than "done" through daisyUI's tone modifiers, without the template
    // knowing why. The fixture's book is running, which asks for the primary
    // tone — the colour of the accent.
    expect(state.className).toContain("badge");
    expect(state.className).toMatch(/badge-(primary|success|error|warning|neutral)/);
    expect(state.className).toContain("badge-primary");
  });

  it("offers the finished book, and opens it where the desktop opens files", async () => {
    const done = { ...summary, state: "done", progress: { done: 9, total: 9 },
      outputPath: "/w/p1/out/a-book-it.epub" };
    const { fixture, invoke } = mount({ "projects.list": [done] });
    await fixture.whenStable();
    fixture.detectChanges();

    const download = fixture.nativeElement.querySelector("[data-testid=download-p1]");
    expect(download).not.toBeNull();
    download.click();
    await fixture.whenStable();

    expect(calls(invoke, "file.open")[0]![1]).toEqual({ path: "/w/p1/out/a-book-it.epub" });
  });

  /**
   * A translation that stopped is work half paid for, and the shelf is where
   * anyone looks for it. The book's own screen asks the machine what it may
   * do and so already offered this; the tile switches on the state's name and
   * offered nothing at all, which read as "this book is over".
   */
  it("offers a book whose run failed the way back into it", async () => {
    const stopped = { ...summary, state: "failed", progress: { done: 3, total: 9 } };
    const { fixture, invoke } = mount({ "projects.list": [stopped] });
    await fixture.whenStable();
    fixture.detectChanges();

    const resume = fixture.nativeElement.querySelector("[data-testid=resume]");
    expect(resume).not.toBeNull();
    resume.click();
    await fixture.whenStable();

    expect(calls(invoke, "run.start")[0]![1]).toEqual({ projectId: "p1" });
  });

  it("offers nothing to open for a book that was never composed", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=download-p1]")).toBeNull();
  });

  /*
   * Deleting is one act among many on a shelf, and the loudest thing on a card
   * should be the book, not the way to lose it. It keeps its name where a name
   * is what is read: for the screen reader, and under the pointer.
   */
  it("keeps deleting quiet, and named for anything that reads rather than looks", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const remove = fixture.nativeElement.querySelector("[data-testid=delete-p1]");
    expect(remove.className).not.toContain("btn-error");
    expect(remove.getAttribute("aria-label")).toBe(it_IT.library.delete);
    expect(remove.querySelector("svg")).not.toBeNull();
  });

  it("asks the main process for the group it was routed to", async () => {
    const { fixture, invoke } = mount();
    fixture.componentRef.setInput("bucket", "to-approve");
    await fixture.whenStable();

    // The group travels to the database, not to a filter in the window: the
    // counts in the column and the rows in the grid must be the same truth.
    expect(calls(invoke, "projects.list").at(-1)![1]).toMatchObject({ bucket: "to-approve" });
  });

  it("says the group is empty, not that there is nothing to start from", async () => {
    const { fixture } = mount({ "projects.list": [] });
    fixture.componentRef.setInput("bucket", "to-approve");
    await fixture.whenStable();
    fixture.detectChanges();

    // A group's page is not the library: the column can say 1 while this grid
    // holds nothing, and "no projects" there is a sentence about somewhere else.
    expect(fixture.nativeElement.querySelector(".library__empty").textContent!.trim())
      .toBe(it_IT.library.emptyBucket);
  });

  it("promises there is nothing to start from only on the page that holds every book", async () => {
    const { fixture } = mount({ "projects.list": [] });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector(".library__empty").textContent!.trim())
      .toBe(it_IT.library.empty);
  });

  it("asks before deleting, naming the book", async () => {
    const { fixture, invoke } = mount({ "projects.list": [summary], "ui.confirm": { confirmed: true } });
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector("[data-testid=delete-p1]").click();
    await fixture.whenStable();

    expect(calls(invoke, "ui.confirm")[0]![1]).toMatchObject({
      kind: "deleteProject", detail: { title: summary.title },
    });
    expect(calls(invoke, "project.delete")).toHaveLength(1);
  });

  it("deletes nothing when the answer is no", async () => {
    const { fixture, invoke } = mount({ "projects.list": [summary], "ui.confirm": { confirmed: false } });
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector("[data-testid=delete-p1]").click();
    await fixture.whenStable();

    // A refusal is an answer, and an answer that destroys nothing.
    expect(calls(invoke, "project.delete")).toHaveLength(0);
  });

  it("will not send anyone to a form they cannot finish", async () => {
    const { fixture } = mount({ "providers.list": [] });
    await fixture.whenStable();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("[data-testid=new-project]");
    expect(button.hasAttribute("disabled")).toBe(true);
    // Spelled out, and with the way to fix it: a dead button that explains
    // nothing is a bug report waiting to be filed.
    expect(fixture.nativeElement.querySelector("[data-testid=needs-provider]")).not.toBeNull();
  });

  it("does not count a provider that serves no model", async () => {
    const noModels = [{
      id: "pv1", name: "Acme", route: "acme", baseUrl: null, headers: {}, options: {},
      catalogId: null, catalogAt: null, hasKey: true, models: [],
    }];
    const { fixture } = mount({ "providers.list": noModels });
    await fixture.whenStable();
    fixture.detectChanges();

    // The form asks for a model too. A provider with none makes it just as
    // impossible to finish as no provider at all.
    expect(fixture.nativeElement.querySelector("[data-testid=new-project]").hasAttribute("disabled"))
      .toBe(true);
  });
});
