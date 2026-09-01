import { TestBed } from "@angular/core/testing";
import { TranslocoService } from "@jsverse/transloco";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../locales/it.json";
import type { Settings } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { provideI18n } from "../core/i18n";
import { Preferences } from "./preferences";

const stored: Settings = {
  uiLanguage: "it",
  concurrency: 2,
  epubcheckJar: null,
};

function bridge(answers: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (channel: string, payload?: unknown) => {
    if (channel in answers) return answers[channel];
    if (channel === "settings.get") return stored;
    if (channel === "settings.set") return { ...stored, ...(payload as Partial<Settings>) };
    return undefined;
  });
}

function mount(group: "translation" | "application", invoke = bridge()) {
  TestBed.configureTestingModule({
    imports: [Preferences],
    providers: [
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: () => () => {} } },
    ],
  });
  const fixture = TestBed.createComponent(Preferences);
  fixture.componentRef.setInput("group", group);
  return { fixture, invoke };
}

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([name]) => name === channel);

const catalogue = it_IT as unknown as { prefs: Record<string, string> };

describe("Preferences", () => {
  it("shows only the group it was asked for", async () => {
    const { fixture } = mount("translation");
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(catalogue.prefs["concurrency"]);
    expect(text).not.toContain(catalogue.prefs["uiLanguage"]);
  });

  it("no longer decides for every book what a run walks past", async () => {
    const { fixture } = mount("translation");
    await fixture.whenStable();
    fixture.detectChanges();

    // The choice moved onto the project. Leaving a global switch here would
    // mean two places claiming to own one fact.
    expect(fixture.nativeElement.querySelector("[data-testid=auto-terms]")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=auto-exclusions]")).toBeNull();
  });

  it("changes the interface language at once, not at the next start", async () => {
    const { fixture } = mount("application");
    await fixture.whenStable();
    const transloco = TestBed.inject(TranslocoService);
    const setActive = vi.spyOn(transloco, "setActiveLang");

    await fixture.componentInstance.patch({ uiLanguage: "en" });

    // A language setting that only takes effect after a restart looks like a
    // setting that does not work.
    expect(setActive).toHaveBeenCalledWith("en");
  });

  it("asks the main process for the jar, and never names a path itself", async () => {
    const invoke = bridge({ "settings.chooseJar": { ...stored, epubcheckJar: "/opt/epubcheck.jar" } });
    const { fixture } = mount("application", invoke);
    await fixture.whenStable();

    await fixture.componentInstance.chooseJar();
    fixture.detectChanges();

    expect(calls(invoke, "settings.chooseJar")[0]![1]).toBeUndefined();
    expect(fixture.nativeElement.textContent as string).toContain("/opt/epubcheck.jar");
  });

  it("clears the jar with null, which is what removes the row", async () => {
    const { fixture, invoke } = mount("application");
    await fixture.whenStable();

    await fixture.componentInstance.clearJar();

    expect(calls(invoke, "settings.set")[0]![1]).toEqual({ epubcheckJar: null });
  });

  it("shows what is stored again when the store refused the change", async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "settings.get") return stored;
      throw { code: "BAD_VALUE" };
    });
    const { fixture } = mount("translation", invoke as never);
    await fixture.whenStable();

    await fixture.componentInstance.patch({ concurrency: 0 });

    // The screen must not go on showing a value the store rejected.
    expect(fixture.componentInstance.settings()).toMatchObject({ concurrency: 2 });
    expect(fixture.componentInstance.failure()).toBe("BAD_VALUE");
  });

  /**
   * A refused setting used to cost one sentence that named no reason. The
   * classified failure says which afternoon this is: a busy database is waited
   * out, and a code nobody catalogued still gets a floor.
   */
  it("says why the setting could not be saved, even for a code nobody catalogued", async () => {
    // The code is read when the question is asked, so one mount watches the
    // answer change between the two attempts.
    let code = "DATABASE_BUSY";
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "settings.get") return stored;
      throw { code, fault: "transient" };
    });
    const { fixture } = mount("translation", invoke as never);
    await fixture.whenStable();

    await fixture.componentInstance.patch({ concurrency: 4 });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=prefs-failure]").textContent)
      .toContain("Il database era occupato.");

    code = "SOMETHING_NEW";
    await fixture.componentInstance.patch({ concurrency: 4 });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=prefs-failure]").textContent)
      .toContain("Il provider non ha risposto.");
  });

  it("writes no sentence of its own: every label comes from the catalogue", async () => {
    const { fixture } = mount("application");
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent as string).not.toContain("prefs.");
  });
});
