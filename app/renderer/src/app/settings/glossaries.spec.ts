import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../locales/it.json";
import type { GlossaryView } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { provideI18n } from "../core/i18n";
import { Glossaries } from "./glossaries";

const fantasy: GlossaryView = {
  id: "g1",
  name: "fantasy",
  version: 2,
  description: "Epic fantasy with invented names",
  sourceLanguage: "en",
  targetLanguage: "it",
  terms: [
    { source: "Rivendell", rule: "dnt", origin: "glossary" },
    { source: "dwarf", target: "nano", rule: "must", origin: "glossary" },
  ],
};

function bridge(answers: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (channel: string, _payload?: unknown) => {
    if (channel in answers) return answers[channel];
    if (channel === "glossaries.list") return [fantasy];
    if (channel === "ui.confirm") return { confirmed: true };
    if (channel === "glossary.delete") return { detachedFrom: 3 };
    return undefined;
  });
}

function mount(invoke = bridge()) {
  TestBed.configureTestingModule({
    imports: [Glossaries],
    providers: [
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: () => () => {} } },
    ],
  });
  const fixture = TestBed.createComponent(Glossaries);
  return { fixture, invoke };
}

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([name]) => name === channel);

const catalogue = it_IT as unknown as { glossaries: Record<string, string> };

describe("Glossaries", () => {
  it("lists what is stored, with the version that rides in the cache key", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("fantasy");
    expect(text).toContain("Epic fantasy with invented names");
    expect(text).toContain("2");
  });

  it("never reads a file itself: the import goes through the main process", async () => {
    const { fixture, invoke } = mount(bridge({ "glossary.importFile": fantasy }));
    await fixture.whenStable();

    await fixture.componentInstance.importFile();

    // No path crosses the boundary in either direction — the window asks, and
    // the main process answers with what it parsed.
    expect(calls(invoke, "glossary.importFile")[0]![1]).toBeUndefined();
    expect(calls(invoke, "glossaries.list").length).toBeGreaterThan(1);
  });

  it("does not reload when the import dialog was dismissed", async () => {
    const { fixture, invoke } = mount(bridge({ "glossary.importFile": null }));
    await fixture.whenStable();
    const before = calls(invoke, "glossaries.list").length;

    await fixture.componentInstance.importFile();

    expect(calls(invoke, "glossaries.list")).toHaveLength(before);
  });

  /**
   * A failed import used to cost one sentence that named no reason. The
   * classified failure says which afternoon this is: a busy database is waited
   * out, and a code nobody catalogued still gets a floor.
   */
  it("says why the import could not happen, even for a code nobody catalogued", async () => {
    // The code is read when the question is asked, so one mount watches the
    // answer change between the two imports.
    let code = "DATABASE_BUSY";
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "glossaries.list") return [fantasy];
      throw { code, fault: "transient" };
    });
    const { fixture } = mount(invoke as never);
    await fixture.whenStable();

    await fixture.componentInstance.importFile();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=glossaries-failure]").textContent)
      .toContain("Il database era occupato.");

    code = "SOMETHING_NEW";
    await fixture.componentInstance.importFile();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=glossaries-failure]").textContent)
      .toContain("Il provider non ha risposto.");
  });

  it("asks before a glossary goes, and a refusal deletes nothing", async () => {
    const { fixture, invoke } = mount(bridge({ "ui.confirm": { confirmed: false } }));
    await fixture.whenStable();

    await fixture.componentInstance.remove(fantasy);

    // The question names the glossary, so the count of the projects about to
    // lose it can be read before the answer, not after the fact.
    expect(calls(invoke, "ui.confirm")[0]![1]).toMatchObject({
      kind: "deleteGlossary", detail: { id: "g1", name: "fantasy" },
    });
    expect(calls(invoke, "glossary.delete")).toHaveLength(0);
  });

  it("deletes once the question is answered, and reports nothing afterwards", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    await fixture.componentInstance.remove(fantasy);
    fixture.detectChanges();

    expect(calls(invoke, "glossary.delete")).toHaveLength(1);
    // The projects that lost the glossary were named in the question; saying
    // it again after the fact is a report about something nobody can undo.
    expect(fixture.nativeElement.querySelector("[data-testid=detached]")).toBeNull();
  });

  it("edits a copy, so abandoning the form leaves the list untouched", async () => {
    const { fixture } = mount();
    await fixture.whenStable();

    fixture.componentInstance.edit(fantasy);
    fixture.componentInstance.patchTerm(0, "source", "Gran Burrone");
    fixture.componentInstance.cancel();

    expect(fantasy.terms[0]!.source).toBe("Rivendell");
  });

  it("drops an emptied field instead of storing an empty string", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    fixture.componentInstance.edit(fantasy);
    fixture.componentInstance.patchTerm(1, "target", "   ");
    await fixture.componentInstance.save();

    // The markdown format round-trips an empty cell as no value at all, so a
    // stored "" would come back as a difference that changes the version.
    const saved = calls(invoke, "glossary.save")[0]![1] as GlossaryView;
    expect("target" in saved.terms[1]!).toBe(false);
  });

  it("saves the whole glossary in one call, terms included", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    fixture.componentInstance.edit(fantasy);
    fixture.componentInstance.addTerm();
    fixture.componentInstance.patchTerm(2, "source", "Mordor");
    await fixture.componentInstance.save();

    const saved = calls(invoke, "glossary.save");
    expect(saved).toHaveLength(1);
    expect((saved[0]![1] as GlossaryView).terms).toHaveLength(3);
  });

  it("refuses to save a glossary with a nameless term", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    fixture.componentInstance.edit(fantasy);
    fixture.componentInstance.addTerm();
    await fixture.componentInstance.save();

    expect(calls(invoke, "glossary.save")).toHaveLength(0);
  });

  it("writes no sentence of its own: every label comes from the catalogue", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(catalogue.glossaries["import"]);
    expect(text).not.toContain("glossaries.");
  });
});
