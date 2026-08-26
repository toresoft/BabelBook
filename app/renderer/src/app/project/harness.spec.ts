import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "../settings/providers";
import { IpcService } from "../core/ipc.service";
import { provideI18n } from "../core/i18n";

/**
 * Not a test of the providers screen — a test of the harness.
 *
 * It mounts the most demanding component that already exists: an external
 * template, an external stylesheet, Transloco and an injected IpcService. If
 * this renders, the five screens of this task can be tested the same way.
 */
describe("the component harness", () => {
  it("renders a real component, template, catalogue and all", async () => {
    const invoke = vi.fn(async (channel: string) => {
      // Honest shapes for the channels the screen asks on open; everything
      // else is an empty list, which is a fine answer from the harness.
      if (channel === "catalog.state") {
        return { at: "2026-08-20T10:00:00.000Z", providers: 1, models: 1, bundled: true };
      }
      return [];
    });
    TestBed.configureTestingModule({
      imports: [Providers],
      providers: [
        provideRouter([]),
        ...provideI18n("it"),
        { provide: IpcService, useValue: { invoke, on: () => () => {} } },
      ],
    });

    const fixture = TestBed.createComponent(Providers);
    await fixture.whenStable();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("Provider");
    expect(invoke).toHaveBeenCalledWith("providers.list", undefined);
  });
});
