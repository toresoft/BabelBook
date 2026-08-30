import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import type { ProjectDetail } from "../../../../../shared/dto.js";
import { provideI18n } from "../../core/i18n";
import { Side } from "./side";

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
  outputPath: null,
};

function mount(project = detail) {
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
});
