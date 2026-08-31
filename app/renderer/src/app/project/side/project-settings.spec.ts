import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import type { ProjectDetail, Provider } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { provideI18n } from "../../core/i18n";
import { ProjectSettings } from "./project-settings";

const provider: Provider = {
  id: "pv1", name: "Acme", route: "acme", baseUrl: null, headers: {}, options: {},
  catalogId: null, catalogAt: null, hasKey: true,
  models: [
    { id: "m1", displayName: "M1", contextWindow: null, priceIn: null, priceOut: null,
      capabilities: null, reasoningLevel: null },
    { id: "m2", displayName: "M2", contextWindow: null, priceIn: null, priceOut: null,
      capabilities: null, reasoningLevel: null },
  ],
};

const detail = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1", title: "A Book", coverPath: null, sourceLanguage: "en", targetLanguage: "it",
  state: "ready", progress: { done: 0, total: 10 }, layout: "reflowable",
  createdAt: "2026-08-31T00:00:00.000Z", outputPath: null,
  description: null, hasOverlays: false,
  providerId: "pv1", modelId: "m1", providerName: "Acme", modelName: "M1",
  autoAcceptTerms: true, autoAcceptExclusions: true,
  actions: [], tokens: { in: 0, out: 0, reasoning: 0 }, cost: null,
  runStartedAt: null, runEndedAt: null, phases: [], finishedAt: null,
  ...over,
});

function mount(project = detail(), answers: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel in answers) {
      const answer = answers[channel];
      return typeof answer === "function" ? answer(payload) : answer;
    }
    if (channel === "providers.list") return [provider];
    if (channel === "ui.confirm") return { confirmed: true };
    return undefined;
  });
  TestBed.configureTestingModule({
    imports: [ProjectSettings],
    providers: [...provideI18n("it"), { provide: IpcService, useValue: { invoke, on: () => () => {} } }],
  });
  const fixture = TestBed.createComponent(ProjectSettings);
  fixture.componentRef.setInput("project", project);
  return { fixture, invoke };
}

const calls = (invoke: ReturnType<typeof vi.fn>, channel: string) =>
  invoke.mock.calls.filter(([name]: unknown[]) => name === channel);

describe("ProjectSettings", () => {
  it("saves the whole form in one call", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    fixture.componentInstance.autoAcceptTerms.set(false);
    fixture.componentInstance.description.set("A note");
    await fixture.componentInstance.save();

    expect(calls(invoke, "project.update")[0]![1]).toMatchObject({
      id: "p1", providerId: "pv1", modelId: "m1",
      autoAcceptTerms: false, autoAcceptExclusions: true, description: "A note",
    });
  });

  it("asks before a change that stops the work already paid for from counting", async () => {
    const { fixture, invoke } = mount(detail({ progress: { done: 7, total: 10 } }));
    await fixture.whenStable();

    fixture.componentInstance.pickModel("m2");
    await fixture.componentInstance.save();

    expect(calls(invoke, "ui.confirm")[0]![1])
      .toMatchObject({ kind: "contractChange", detail: { title: "A Book", done: 7 } });
  });

  it("does not ask when there is nothing to lose", async () => {
    const { fixture, invoke } = mount(detail({ progress: { done: 0, total: 10 } }));
    await fixture.whenStable();

    fixture.componentInstance.pickModel("m2");
    await fixture.componentInstance.save();

    // A question with no stake teaches people to click through questions
    // that have one.
    expect(calls(invoke, "ui.confirm")).toHaveLength(0);
    expect(calls(invoke, "project.update")).toHaveLength(1);
  });

  it("does not ask when only the endpoint changes", async () => {
    const other: Provider = { ...provider, id: "pv2", name: "Other" };
    const { fixture, invoke } = mount(
      detail({ progress: { done: 7, total: 10 } }),
      { "providers.list": [provider, other] },
    );
    await fixture.whenStable();

    // The cache key is made of the model, not of who serves it: the same model
    // reached through another endpoint is the same work.
    fixture.componentInstance.pickProvider("pv2");
    fixture.componentInstance.pickModel("m1");
    await fixture.componentInstance.save();

    expect(calls(invoke, "ui.confirm")).toHaveLength(0);
  });

  it("keeps the row as it was when the question is answered no", async () => {
    const { fixture, invoke } = mount(
      detail({ progress: { done: 7, total: 10 } }),
      { "ui.confirm": { confirmed: false } },
    );
    await fixture.whenStable();

    fixture.componentInstance.pickModel("m2");
    await fixture.componentInstance.save();

    expect(calls(invoke, "project.update")).toHaveLength(0);
  });
});
