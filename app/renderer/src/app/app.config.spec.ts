import { TestBed } from "@angular/core/testing";
import { TranslocoService } from "@jsverse/transloco";
import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../../../shared/dto.js";
import { settleAppearance } from "./app.config";
import { provideI18n } from "./core/i18n";
import { IpcService } from "./core/ipc.service";

const stored: Settings = {
  uiLanguage: "en",
  autoAcceptTerms: false,
  autoAcceptExclusions: false,
  concurrency: 2,
  epubcheckJar: null,
};

/** A bridge that answers every channel, except the ones named as broken. */
function bridge(broken: string[] = []) {
  return {
    on: () => () => {},
    invoke: vi.fn(async (channel: string) => {
      if (broken.includes(channel)) throw new Error(`${channel} is not there`);
      if (channel === "ui.theme") return { dark: true };
      if (channel === "settings.get") return stored;
      return undefined;
    }),
  };
}

function scene(broken: string[] = []) {
  const ipc = bridge(broken);
  TestBed.configureTestingModule({
    providers: [...provideI18n("it"), { provide: IpcService, useValue: ipc }],
  });
  return { ipc, transloco: TestBed.inject(TranslocoService) };
}

/**
 * What the window has to know before it paints for the first time.
 *
 * The stored language and the system's theme both come from the main process,
 * and neither is worth losing to the other's failure: a setting that is read
 * but not applied is indistinguishable, to the person who set it, from a
 * setting that does nothing.
 */
describe("settling the appearance", () => {
  it("wears the theme the main process reports, and the stored language", async () => {
    const { ipc, transloco } = scene();

    await settleAppearance(TestBed.inject(IpcService), transloco);

    expect(document.documentElement.dataset["theme"]).toBe("babelbook-dark");
    expect(transloco.getActiveLang()).toBe("en");
    expect(ipc.invoke).toHaveBeenCalledWith("ui.theme", undefined);
  });

  it("wears the light theme when the system is light", async () => {
    const ipc = { on: () => () => {}, invoke: vi.fn(async (channel: string) =>
      channel === "ui.theme" ? { dark: false } : stored) };
    TestBed.configureTestingModule({
      providers: [...provideI18n("it"), { provide: IpcService, useValue: ipc }],
    });

    await settleAppearance(TestBed.inject(IpcService), TestBed.inject(TranslocoService));

    // Named, not absent: daisyUI picks a theme by attribute, and no attribute
    // means whatever it considers the default — which is not a decision anyone
    // in this application made.
    expect(document.documentElement.dataset["theme"]).toBe("babelbook");
  });

  it("still applies the stored language when the theme cannot be read", async () => {
    const { transloco } = scene(["ui.theme"]);

    await settleAppearance(TestBed.inject(IpcService), transloco);

    // The two are asked over the same bridge, so a shared catch would let the
    // theme's failure swallow the language and fall back to the system's.
    expect(transloco.getActiveLang()).toBe("en");
  });

  it("still wears the theme when the settings cannot be read", async () => {
    const { transloco } = scene(["settings.get"]);

    await settleAppearance(TestBed.inject(IpcService), transloco);

    expect(document.documentElement.dataset["theme"]).toBe("babelbook-dark");
  });

  it("leaves the guesses standing when there is no bridge at all", async () => {
    const { transloco } = scene(["ui.theme", "settings.get"]);
    document.documentElement.dataset["theme"] = "";

    await settleAppearance(TestBed.inject(IpcService), transloco);

    expect(document.documentElement.dataset["theme"]).toBe("babelbook");
    expect(transloco.getActiveLang()).toBe("it");
  });
});
