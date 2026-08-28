import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import { IpcService } from "../core/ipc.service";
import { provideI18n } from "../core/i18n";
import { Settings } from "./settings";

function bridge() {
  return vi.fn(async (channel: string, _payload?: unknown) => {
    if (channel === "providers.list" || channel === "providers.presets") return [];
    if (channel === "glossaries.list") return [];
    if (channel === "settings.get") {
      return {
        uiLanguage: "it", autoAcceptTerms: false, autoAcceptExclusions: false,
        concurrency: 2, epubcheckJar: null,
      };
    }
    return undefined;
  });
}

function mount() {
  const invoke = bridge();
  TestBed.configureTestingModule({
    imports: [Settings],
    providers: [
      provideRouter([]),
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: () => () => {} } },
    ],
  });
  return { fixture: TestBed.createComponent(Settings), invoke };
}

describe("Settings", () => {
  // The column names the section; this component answers with its panel. What
  // the choosing is no longer this component's to prove — the shell's spec and
  // the e2e walk that — only that each name finds its panel.
  const panels: Record<string, string> = {
    providers: "providers",
    glossaries: "glossaries",
    translation: "prefs-translation",
    application: "prefs-application",
  };

  it("offers the four sections, one panel per name", async () => {
    const { fixture } = mount();
    await fixture.whenStable();

    for (const [section, panel] of Object.entries(panels)) {
      fixture.componentRef.setInput("section", section);
      await fixture.whenStable();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector(`[data-testid=${panel}]`)).not.toBeNull();
    }
  });

  it("opens on the providers, which is where a new installation has to start", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=providers]")).not.toBeNull();
  });

  it("shows one section at a time, and asks nothing for the others", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    // Loading all four at once would ask the main process four questions to
    // answer one.
    expect(invoke.mock.calls.some(([channel]) => channel === "glossaries.list")).toBe(false);

    fixture.componentRef.setInput("section", "glossaries");
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=glossaries]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=providers]")).toBeNull();
  });

  it("shows the two preference groups apart", async () => {
    const { fixture } = mount();
    await fixture.whenStable();

    fixture.componentRef.setInput("section", "translation");
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=prefs-translation]")).not.toBeNull();

    fixture.componentRef.setInput("section", "application");
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=prefs-application]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=prefs-translation]")).toBeNull();
  });

  it("writes no sentence of its own: every label comes from the catalogue", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent as string).not.toContain("settings.");
  });
});
