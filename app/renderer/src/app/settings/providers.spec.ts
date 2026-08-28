import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../locales/it.json";
import type {
  CatalogEntry, CatalogState, LocalRuntime, Provider, ProviderModel,
} from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";
import { provideI18n } from "../core/i18n";
import { Providers } from "./providers";

/**
 * The flow this suite pins down: search, choose, paste — and never a model id
 * typed by hand. Everything the catalogue and the endpoint can say, the screen
 * says for the user.
 */

const entry: CatalogEntry = {
  id: "acme", name: "Acme", route: "acme-compatible",
  baseUrl: "https://api.acme.test/v1", options: {}, models: 12,
  envVar: "ACME_API_KEY",
};

const unserved: CatalogEntry = {
  id: "venice", name: "Venice AI", route: null, baseUrl: null, options: {}, models: 3,
  envVar: null,
};

const priced: ProviderModel = {
  id: "acme-mini", displayName: "Acme Mini", contextWindow: 128_000,
  priceIn: 0.5, priceOut: 2, capabilities: { toolCall: true, reasoning: false, structuredOutput: true, attachment: false },
};

const unpriced: ProviderModel = {
  id: "acme-other", displayName: "acme-other", contextWindow: null,
  priceIn: null, priceOut: null, capabilities: null,
};

const runtime: LocalRuntime = {
  id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "ollama", models: ["gemma3:12b"],
};

const state: CatalogState = {
  at: "2026-08-20T10:00:00.000Z", providers: 203, models: 7339, bundled: true,
  checkedAt: null,
};

/** A rejection the way the preload delivers it: packed in a marker message. */
const failureOf = (code: string) =>
  new Error(`babelbook-failure:${JSON.stringify({ code })}`);

function bridge(answers: Record<string, unknown> = {}) {
  return vi.fn(async (channel: string, payload?: unknown) => {
    // What the test asked for wins over the defaults. The other way round, an
    // override of a channel that has a default is dropped in silence, and the
    // test passes while measuring the fixture instead of its own case.
    if (channel in answers) {
      const answer = answers[channel];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(payload) : answer;
    }
    if (channel === "providers.list") return [] as Provider[];
    if (channel === "providers.presets") return [];
    if (channel === "local.runtimes") return [runtime];
    if (channel === "catalog.state") return state;
    return undefined;
  });
}

function mount(invoke = bridge()) {
  // The real IpcService, with the fake installed as the preload bridge: a
  // rejection then travels the true path — packed by the main process,
  // unpacked by the service — so a code the screen reads is a code that
  // crossed the boundary the way it will in production.
  (globalThis as { window?: { babelbook?: unknown } }).window!.babelbook =
    { invoke, on: () => () => {} };
  TestBed.configureTestingModule({
    imports: [Providers],
    providers: [...provideI18n("it"), IpcService],
  });
  const fixture = TestBed.createComponent(Providers);
  return { fixture, invoke };
}

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([name]) => name === channel);

const catalog = it_IT as unknown as { providers: Record<string, string>; discover: Record<string, string> };

describe("Providers", () => {
  it("finds providers by typing, not by scrolling", async () => {
    const { fixture, invoke } = mount(bridge({ "catalog.search": [entry] }));
    await fixture.whenStable();

    fixture.componentInstance.search("acm");
    await fixture.whenStable();
    fixture.detectChanges();

    expect(calls(invoke, "catalog.search")[0]![1]).toEqual({ query: "acm" });
    expect(fixture.nativeElement.querySelector("[data-testid=entry-acme]")).not.toBeNull();
  });

  it("puts local runtimes first, marked as local and without a key field", async () => {
    const { fixture, invoke } = mount(bridge({ "catalog.search": [entry] }));
    await fixture.whenStable();
    fixture.componentInstance.search("a");
    await fixture.whenStable();
    fixture.detectChanges();

    // The runtime sits above the catalogue results, and says it is local.
    const buttons = fixture.nativeElement.querySelectorAll("button");
    const labels = Array.from(buttons as NodeListOf<HTMLElement>, (b) => b.textContent);
    expect(labels.findIndex((t) => t?.includes("Ollama")))
      .toBeLessThan(labels.findIndex((t) => t?.includes("Acme")));
    expect(labels.find((t) => t?.includes("Ollama"))).toContain(catalog.providers["local"]!);

    fixture.componentInstance.pickLocal(runtime);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=provider-api-key]")).toBeNull();
    // Its models are the running server's, ready before any key exists.
    expect(fixture.componentInstance.draft()?.models.map((m) => m.id)).toEqual(["gemma3:12b"]);
  });

  it("asks for one thing only: the key", async () => {
    const { fixture } = mount();
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector("[data-testid=provider-form]") as HTMLElement;

    expect(form.querySelector("[data-testid=provider-api-key]")).not.toBeNull();
    // No name to invent, no route to know, no URL to paste: the entry said so.
    for (const absent of ["provider-name", "provider-route", "provider-base-url"]) {
      expect(form.querySelector(`[data-testid=${absent}]`)).toBeNull();
    }
  });

  it("shows the models the endpoint serves, without a field for any id", async () => {
    const { fixture, invoke } = mount(bridge({
      "catalog.models": [priced, unpriced],
    }));
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    await fixture.componentInstance.findModels();
    fixture.detectChanges();

    expect(calls(invoke, "catalog.models")[0]![1]).toEqual({ entryId: "acme", apiKey: null });
    expect(fixture.componentInstance.draft()?.models).toEqual([priced, unpriced]);

    const form = fixture.nativeElement.querySelector("[data-testid=provider-form]") as HTMLElement;
    for (const absent of ["add-model", "find-model"] /* , anything model-editable */) {
      expect(form.querySelector(`[data-testid=${absent}]`)).toBeNull();
    }
    expect(form.querySelector("input:not([data-testid=provider-api-key])")).toBeNull();
  });

  it("carries price and context next to each model, when they are known", async () => {
    const { fixture } = mount(bridge({ "catalog.models": [priced, unpriced] }));
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    await fixture.componentInstance.findModels();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("Acme Mini");
    expect(text).toContain("128000");
    expect(text).toContain("0.5");
    expect(text).toContain("2");
    // The unpriced model says so, rather than showing nothing: a missing
    // number is a fact the reader deserves to see named.
    expect(text).toContain(catalog.providers["priceUnknown"]!);
  });

  it("says a rejected key with its own words, not the provider's", async () => {
    const { fixture } = mount(bridge({
      "catalog.models": failureOf("unauthorized"),
    }));
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    fixture.componentInstance.patch("apiKey", "sk-wrong");
    await fixture.componentInstance.findModels();
    fixture.detectChanges();

    expect(fixture.componentInstance.failure()).toBe("unauthorized");
    const said = fixture.nativeElement.querySelector("[data-testid=provider-failure]") as HTMLElement;
    expect(said.textContent).toContain(catalog.discover["unauthorized"]!);
  });

  it("keeps the compatible endpoint as the declared way to what the catalogue does not know", async () => {
    const { fixture, invoke } = mount(bridge({
      "provider.discover": [unpriced],
    }));
    await fixture.whenStable();

    fixture.componentInstance.pickCompatible();
    fixture.componentInstance.patch("compatUrl", "https://gateway.internal/v1");
    await fixture.componentInstance.findModels();
    fixture.detectChanges();

    expect(calls(invoke, "provider.discover")[0]![1])
      .toEqual({ baseUrl: "https://gateway.internal/v1", apiKey: null });
    expect(fixture.nativeElement.querySelector("[data-testid=provider-base-url]")).not.toBeNull();
    expect(fixture.componentInstance.draft()?.models).toEqual([unpriced]);
  });

  it("loads the catalogue's own list when the entry declares no endpoint to ask", async () => {
    const noUrl = { ...entry, baseUrl: null };
    const { fixture, invoke } = mount(bridge({ "catalog.models": [priced] }));
    await fixture.whenStable();

    fixture.componentInstance.pick(noUrl);
    await fixture.whenStable();
    fixture.detectChanges();

    // The list came from the catalogue entry itself, key or no key.
    expect(calls(invoke, "catalog.models")[0]![1]).toEqual({ entryId: "acme", apiKey: null });
    expect(fixture.componentInstance.draft()?.models).toEqual([priced]);
  });

  it("says how old the catalogue is, in one line", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const line = fixture.nativeElement.querySelector("[data-testid=catalog-state]") as HTMLElement;
    expect(line.textContent).toContain("2026-08-20");
    expect(line.textContent).toContain("203");
  });

  // Production break: a catalogue confirmed current reads as three weeks stale.
  it("says when the network last confirmed the list", async () => {
    const { fixture } = mount(bridge({
      "catalog.state": { ...state, checkedAt: "2026-08-27T09:00:00.000Z" },
    }));
    await fixture.whenStable();
    fixture.detectChanges();

    const line = fixture.nativeElement.querySelector("[data-testid=catalog-checked]");
    expect(line).not.toBeNull();
    expect((line as HTMLElement).textContent).toContain("2026-08-27");
  });

  it("says nothing about a confirmation that never happened", async () => {
    // Never confirmed is a different fact from confirmed long ago, and an
    // invented date here would be the kind a reader believes.
    const { fixture } = mount(bridge());
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=catalog-checked]")).toBeNull();
  });

  it("updates the catalogue on request, and the line moves with it", async () => {
    const fresher: CatalogState = {
      at: "2026-08-26T00:00:00.000Z", providers: 204, models: 7500, bundled: false,
      checkedAt: "2026-08-26T00:00:00.000Z",
    };
    const { fixture, invoke } = mount(bridge({ "catalog.refresh": fresher }));
    await fixture.whenStable();

    await fixture.componentInstance.refreshCatalog();
    fixture.detectChanges();

    expect(calls(invoke, "catalog.refresh").length).toBe(1);
    const line = fixture.nativeElement.querySelector("[data-testid=catalog-state]") as HTMLElement;
    expect(line.textContent).toContain("2026-08-26");
    expect(fixture.nativeElement.querySelector("[data-testid=catalog-outcome]")!.textContent)
      .toContain(catalog.providers["catalogUpdated"]!);
  });

  it("answers a failed refresh with a line, not an alarm", async () => {
    const { fixture } = mount(bridge({ "catalog.refresh": failureOf("REFRESH_FAILED") }));
    await fixture.whenStable();

    await fixture.componentInstance.refreshCatalog();
    fixture.detectChanges();

    // The state line still says what is in use; nothing was pretended.
    const line = fixture.nativeElement.querySelector("[data-testid=catalog-state]") as HTMLElement;
    expect(line.textContent).toContain("2026-08-20");
    expect(fixture.nativeElement.querySelector("[data-testid=catalog-outcome]")!.textContent)
      .toContain(catalog.providers["catalogRefreshFailed"]!);
  });

  it("refuses a file that is not a catalogue, and keeps what works", async () => {
    const { fixture } = mount(bridge({ "catalog.importFile": failureOf("BAD_CATALOG") }));
    await fixture.whenStable();

    await fixture.componentInstance.importCatalog();
    fixture.detectChanges();

    expect(fixture.componentInstance.catalogState()?.at).toBe(state.at);
    expect(fixture.nativeElement.querySelector("[data-testid=catalog-outcome]")!.textContent)
      .toContain(catalog.providers["catalogBadImport"]!);
  });

  it("never sends the key back when saving an edit", async () => {
    const saved: Provider = {
      id: "p1", name: "Acme", route: "acme-compatible",
      baseUrl: "https://api.acme.test/v1", headers: {}, options: {},
      catalogId: "acme", catalogAt: "2026-08-20T10:00:00.000Z",
      models: [priced], hasKey: true,
    };
    const { fixture, invoke } = mount(bridge({ "providers.list": [saved] }));
    await fixture.whenStable();

    fixture.componentInstance.edit(saved);
    fixture.componentInstance.patch("name", "Acme Europe");
    await fixture.componentInstance.save();
    fixture.detectChanges();

    const body = calls(invoke, "provider.update")[0]![1] as Record<string, unknown>;
    expect(body["name"]).toBe("Acme Europe");
    expect("apiKey" in body).toBe(false);
    // An edit has no business rewriting the models it did not touch.
    expect(body["models"]).toBeUndefined();
  });

  it("asks before a provider goes, and a refusal keeps it", async () => {
    const stored: Provider = {
      id: "p1", name: "Acme", route: "acme-compatible",
      baseUrl: "https://api.acme.test/v1", headers: {}, options: {},
      catalogId: "acme", catalogAt: "2026-08-20T10:00:00.000Z",
      models: [priced], hasKey: true,
    };
    const { fixture, invoke } = mount(bridge({ "ui.confirm": { confirmed: false } }));
    await fixture.whenStable();

    await fixture.componentInstance.remove(stored);

    // The provider and its encrypted key go together; the question says which
    // one it is about to take.
    expect(calls(invoke, "ui.confirm")[0]![1]).toMatchObject({
      kind: "deleteProvider", detail: { name: "Acme" },
    });
    expect(calls(invoke, "provider.delete")).toHaveLength(0);
  });

  it("shows an entry it cannot serve, and refuses to let it be chosen", async () => {
    const { fixture } = mount(bridge({ "catalog.search": [entry, unserved] }));
    await fixture.whenStable();

    fixture.componentInstance.search("a");
    await fixture.whenStable();
    fixture.detectChanges();

    const served = fixture.nativeElement
      .querySelector("[data-testid=entry-acme]") as HTMLButtonElement;
    const refused = fixture.nativeElement
      .querySelector("[data-testid=entry-venice]") as HTMLButtonElement | null;

    // Visible, because a name that vanishes from the list teaches nothing;
    // unpressable, because the sentence about it belongs here and not three
    // steps later, after a key has been pasted.
    expect(served.disabled).toBe(false);
    expect(refused).not.toBeNull();
    expect(refused!.disabled).toBe(true);
    expect(refused!.getAttribute("title")).toBe(catalog.providers["unserved"]);
  });
});
