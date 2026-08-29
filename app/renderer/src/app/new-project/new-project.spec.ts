import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../locales/it.json";
import type { CreatedProject, Provider } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { provideI18n } from "../core/i18n";
import { NewProject } from "./new-project";

/**
 * The estimate and the money: with a model that declares prices the guess
 * says a cost, without one it says tokens only — and the chosen provider and
 * model travel with the project, so the run knows what to bill against.
 */

const priced: Provider = {
  id: "pv1", name: "Acme", route: "acme", baseUrl: null, headers: {}, options: {},
  catalogId: "acme", catalogAt: "2026-08-20T00:00:00.000Z", hasKey: true,
  models: [
    { id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5,
      capabilities: null, reasoningLevel: null },
    { id: "m2", displayName: "m2", contextWindow: null, priceIn: null, priceOut: null,
      capabilities: null, reasoningLevel: null },
  ],
};

const analysed: CreatedProject = {
  id: "p1", title: "A Book", coverPath: null, declaredLanguage: "en", documents: 3,
  units: { total: 40, work: 30, byState: {} }, words: 100_000,
  layout: { book: "reflowable", prePaginated: 0, documents: 3 }, hasOverlays: false,
};

function bridge(answers: Record<string, unknown> = {}) {
  return vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === "providers.list") return [priced];
    if (channel === "project.chooseEpub") return { path: "/books/a.epub", name: "a.epub" };
    if (channel === "project.create") return analysed;
    if (channel === "project.update") return undefined;
    if (channel === "project.delete") return undefined;
    if (channel in answers) {
      const answer = answers[channel];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(payload) : answer;
    }
    return undefined;
  });
}

function mount(invoke = bridge()) {
  (globalThis as { window?: { babelbook?: unknown } }).window!.babelbook =
    { invoke, on: () => () => {} };
  TestBed.configureTestingModule({
    imports: [NewProject],
    providers: [provideRouter([]), ...provideI18n("it"), IpcService],
  });
  const fixture = TestBed.createComponent(NewProject);
  return { fixture, invoke };
}

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([name]) => name === channel);

const phrases = it_IT as unknown as { newProject: Record<string, string> };

async function chosen(fixture: Awaited<ReturnType<typeof mount>["fixture"]>) {
  await fixture.componentInstance.choose();
  await fixture.whenStable();
}

describe("NewProject", () => {
  it("estimates money when the chosen model declares prices", async () => {
    const { fixture } = mount();
    await chosen(fixture);

    fixture.componentInstance.pickProvider("pv1");
    fixture.componentInstance.pickModel("m1");
    fixture.detectChanges();

    // 100k words against 1/5 per million: a number, not a mystery.
    expect(fixture.componentInstance.estimated()?.cost).not.toBeNull();
    const line = fixture.nativeElement.querySelector("[data-testid=estimate]") as HTMLElement;
    // Every static fragment of the cost-bearing sentence is on the screen.
    for (const fragment of phrases.newProject["estimateWithCost"]!
      .split(/\{\{\w+\}\}/).filter((part) => part.trim() !== "")) {
      expect(line.textContent).toContain(fragment.trim());
    }
    // The unpriced hint is for the other case.
    expect(fixture.nativeElement.querySelector(".new__hint")).toBeNull();
  });

  it("shows tokens only when no prices are declared, exactly as before", async () => {
    const { fixture } = mount();
    await chosen(fixture);

    fixture.componentInstance.pickProvider("pv1");
    fixture.componentInstance.pickModel("m2");
    fixture.detectChanges();

    expect(fixture.componentInstance.estimated()?.cost).toBeNull();
    expect(fixture.nativeElement.querySelector(".new__hint")!.textContent)
      .toContain(phrases.newProject["noPrices"]!);
  });

  it("sends the chosen provider and model with the project", async () => {
    const { fixture, invoke } = mount();
    await chosen(fixture);

    fixture.componentInstance.pickProvider("pv1");
    fixture.componentInstance.pickModel("m1");
    await fixture.componentInstance.create();

    const sent = calls(invoke, "project.update")[0]![1] as Record<string, unknown>;
    expect(sent).toMatchObject({ id: "p1", providerId: "pv1", modelId: "m1" });
  });

  it("asks before abandoning the project it just analysed, and keeps it when refused", async () => {
    const { fixture, invoke } = mount(bridge({ "ui.confirm": { confirmed: false } }));
    await chosen(fixture);

    await fixture.componentInstance.cancel();

    // Cancelling destroys the analysed project and its workspace: the
    // question is what stands between the button and that.
    expect(calls(invoke, "ui.confirm")[0]![1]).toMatchObject({
      kind: "abandonProject", detail: { title: "A Book" },
    });
    expect(calls(invoke, "project.delete")).toHaveLength(0);
  });

  it("leaves without a question when there is nothing to destroy yet", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    await fixture.componentInstance.cancel();

    expect(calls(invoke, "ui.confirm")).toHaveLength(0);
    expect(calls(invoke, "project.delete")).toHaveLength(0);
  });

  it("makes Create the primary act and Cancel the quiet one", async () => {
    const { fixture } = mount();
    await chosen(fixture);
    fixture.detectChanges();

    // The two buttons do opposite things of opposite weight: identical ones
    // invited the click that throws the analysis away.
    const create = fixture.nativeElement.querySelector("[data-testid=create]");
    const cancel = fixture.nativeElement.querySelector("[data-testid=cancel]");
    expect(create.className).toContain("btn-primary");
    expect(cancel.className).not.toContain("btn-primary");
  });

  it("puts the estimate first after the title, before the form it decides about", async () => {
    const { fixture } = mount();
    await chosen(fixture);

    fixture.componentInstance.pickProvider("pv1");
    fixture.componentInstance.pickModel("m1");
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const at = (selector: string): number => {
      const found = root.querySelector(selector);
      expect(found, selector).not.toBeNull();
      return [...root.querySelectorAll("*")].indexOf(found!);
    };

    // The estimate is what the decision turns on, so it is the first thing
    // read after the book — not a footnote below the whole form.
    expect(at("[data-testid=preview-title]")).toBeLessThan(at("[data-testid=estimate]"));
    expect(at("[data-testid=estimate]")).toBeLessThan(at("[data-testid=target-language]"));
  });
});
