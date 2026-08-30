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
});
