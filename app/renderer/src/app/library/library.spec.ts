import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSummary } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { provideI18n } from "../core/i18n";
import { Library } from "./library";

const book: ProjectSummary = {
  id: "p1", title: "A Book", coverPath: null, sourceLanguage: "en", targetLanguage: "it",
  state: "running", progress: { done: 3, total: 9 }, layout: "reflowable",
  createdAt: "2026-08-27T00:00:00.000Z",
};

function mount(projects: ProjectSummary[] = [book]) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "projects.list") return projects;
    return undefined;
  });
  TestBed.configureTestingModule({
    imports: [Library],
    providers: [
      provideRouter([]),
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: () => () => {} } },
    ],
  });
  const fixture = TestBed.createComponent(Library);
  return { fixture };
}

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
    expect(entry.className).toContain("btn--primary");
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
    // A class of its own per state is the hook the stylesheet needs: "failed"
    // can carry another colour than "done", without the template knowing why.
    expect(state.className).toMatch(/tile__state--[\w-]+/);
  });
});
