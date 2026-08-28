import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../locales/it.json";
import type {
  CatalogEntry, CatalogState, LocalRuntime, Provider, ProviderModel,
} from "../../../../shared/dto.js";
import { POPULAR } from "../../../../main/catalog/popular.js";
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

  it("opens on the ten recommended, before anything is typed", async () => {
    const ten: CatalogEntry[] = POPULAR.map((id) => ({ ...entry, id, name: id }));
    const { fixture, invoke } = mount(bridge({ "catalog.search": () => ten }));
    await fixture.whenStable();
    fixture.nativeElement.querySelector("[data-testid=open-connect]").click();
    await fixture.whenStable();
    fixture.detectChanges();

    // The modal's first question is the empty one; the service answers it
    // with the ten, so the popular group is the opening state, not a reward
    // for typing.
    expect(calls(invoke, "catalog.search")[0]![1]).toEqual({ query: "" });
    expect(fixture.nativeElement.querySelector("[data-testid=entry-anthropic]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=entry-cerebras]")).not.toBeNull();
    // All ten are the recommended: "others" holds none of them.
    expect(fixture.componentInstance.others()).toEqual([]);
  });

  it("puts local runtimes first, marked as local and without a key field", async () => {
    const { fixture, invoke } = mount(bridge({ "catalog.search": [entry] }));
    await fixture.whenStable();
    fixture.componentInstance.search("a");
    await fixture.whenStable();
    fixture.detectChanges();

    // The runtime sits above the catalogue results, and says it is local. The
    // dialog's own DOM holds both, closed or not.
    const rows = fixture.nativeElement.querySelectorAll("[data-testid=connect-modal] a");
    const labels = Array.from(rows as NodeListOf<HTMLElement>, (a) => a.textContent);
    expect(labels.findIndex((t) => t?.includes("Ollama")))
      .toBeLessThan(labels.findIndex((t) => t?.includes("Acme")));
    expect(labels.find((t) => t?.includes("Ollama"))).toContain(catalog.providers["local"]!);

    fixture.componentInstance.pickLocal(runtime);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=provider-api-key]")).toBeNull();
    // Its models are the running server's, ready before any key exists.
    expect(fixture.componentInstance.draft()?.models.map((m) => m.id)).toEqual(["gemma3:12b"]);
  });

  it("puts what runs on this machine above what asks for money", async () => {
    const { fixture } = mount(bridge({ "catalog.search": [entry] }));
    await fixture.whenStable();
    fixture.nativeElement.querySelector("[data-testid=open-connect]").click();
    await fixture.whenStable();
    fixture.componentInstance.search("a");
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.querySelector("[data-testid=connect-modal]").textContent as string;

    // Local runtimes are the only group that asks nobody for a key. Someone with
    // a model on their own machine should meet it first, not after eight paid
    // services.
    expect(text.indexOf("Ollama")).toBeLessThan(text.indexOf("Acme"));
  });

  it("offers the custom endpoint as an entry of the list, not a mode beside it", async () => {
    const { fixture } = mount(bridge({ "catalog.search": [entry] }));
    await fixture.whenStable();
    fixture.nativeElement.querySelector("[data-testid=open-connect]").click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=entry-custom]")).not.toBeNull();
  });

  it("says of an entry how many models it serves and where its key usually lives", async () => {
    const { fixture } = mount(bridge({ "catalog.search": [entry] }));
    await fixture.whenStable();
    fixture.nativeElement.querySelector("[data-testid=open-connect]").click();
    await fixture.whenStable();
    fixture.componentInstance.search("acm");
    await fixture.whenStable();
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector("[data-testid=entry-acme]").textContent as string;
    expect(row).toContain("12");
    expect(row).toContain("ACME_API_KEY");
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

  it("asks for a key and nothing else when the catalogue knows the address", async () => {
    const { fixture } = mount(bridge({ "catalog.search": [entry] }));
    await fixture.whenStable();
    fixture.componentInstance.search("acm");
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector("[data-testid=entry-acme]").click();
    await fixture.whenStable();
    fixture.detectChanges();

    // Connecting is one act. The model comes later, on a provider that has a
    // key — which is the only moment its models exist at all.
    expect(fixture.nativeElement.querySelector("[data-testid=provider-api-key]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=provider-base-url]")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=model-list]")).toBeNull();
  });

  it("asks for an address too when the catalogue knows none", async () => {
    const bare: CatalogEntry = { ...entry, id: "bare", name: "Bare", baseUrl: null, envVar: null };
    const { fixture } = mount(bridge({ "catalog.search": [bare] }));
    await fixture.whenStable();
    fixture.componentInstance.search("bar");
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector("[data-testid=entry-bare]").click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=provider-base-url]")).not.toBeNull();
  });

  it("connects with the models the endpoint serves, without a field for any id", async () => {
    const { fixture, invoke } = mount(bridge({
      "catalog.models": [priced, unpriced],
    }));
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector("[data-testid=provider-form]") as HTMLElement;

    // The module asks for nothing but the key: no id to invent, no list to
    // browse — the models are not its to show anymore.
    for (const absent of ["add-model", "find-models", "model-list"]) {
      expect(form.querySelector(`[data-testid=${absent}]`)).toBeNull();
    }
    expect(form.querySelector("input:not([data-testid=provider-api-key])")).toBeNull();

    await fixture.componentInstance.save();

    // The models arrive while the key is still in hand, which is the one
    // moment they can: at save, straight onto the provider being created.
    expect(calls(invoke, "catalog.models")[0]![1]).toEqual({ entryId: "acme", apiKey: null });
    const body = calls(invoke, "provider.create")[0]![1] as Record<string, unknown>;
    expect(body["models"]).toEqual([priced, unpriced]);
  });

  it("carries price and context with each model into the provider, when they are known", async () => {
    const { fixture, invoke } = mount(bridge({ "catalog.models": [priced, unpriced] }));
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    await fixture.componentInstance.save();

    const body = calls(invoke, "provider.create")[0]![1] as { models: ProviderModel[] };
    const stored = body.models.find((m) => m.id === "acme-mini")!;
    expect(stored.displayName).toBe("Acme Mini");
    expect(stored.contextWindow).toBe(128_000);
    expect(stored.priceIn).toBe(0.5);
    expect(stored.priceOut).toBe(2);
    // The unpriced model keeps its nulls rather than a number someone would
    // believe: a missing price is a fact, not a zero.
    const unpricedStored = body.models.find((m) => m.id === "acme-other")!;
    expect(unpricedStored.priceIn).toBeNull();
    expect(unpricedStored.priceOut).toBeNull();
  });

  it("says a rejected key with its own words, and connects nothing", async () => {
    const { fixture, invoke } = mount(bridge({
      "catalog.models": failureOf("unauthorized"),
    }));
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    fixture.componentInstance.patch("apiKey", "sk-wrong");
    await fixture.componentInstance.save();
    fixture.detectChanges();

    // The typed key crossed to the main process exactly once, to be refused.
    expect(calls(invoke, "catalog.models")[0]![1]).toEqual({ entryId: "acme", apiKey: "sk-wrong" });
    expect(fixture.componentInstance.failure()).toBe("unauthorized");
    const said = fixture.nativeElement.querySelector("[data-testid=provider-failure]") as HTMLElement;
    expect(said.textContent).toContain(catalog.discover["unauthorized"]!);
    // A key that cannot reach the models is not a provider: connecting
    // half-modelled is the dead end this refuses.
    expect(calls(invoke, "provider.create")).toHaveLength(0);
    expect(fixture.nativeElement.querySelector("[data-testid=provider-form]")).not.toBeNull();
  });

  it("keeps the compatible endpoint as the declared way to what the catalogue does not know", async () => {
    const { fixture, invoke } = mount(bridge({
      "provider.discover": [unpriced],
    }));
    await fixture.whenStable();

    fixture.componentInstance.pickCompatible();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=provider-base-url]")).not.toBeNull();

    fixture.componentInstance.patch("name", "Gateway");
    fixture.componentInstance.patch("baseUrl", "https://gateway.internal/v1");
    await fixture.componentInstance.save();

    expect(calls(invoke, "provider.discover")[0]![1])
      .toEqual({ baseUrl: "https://gateway.internal/v1", apiKey: null });
    const body = calls(invoke, "provider.create")[0]![1] as Record<string, unknown>;
    expect(body["baseUrl"]).toBe("https://gateway.internal/v1");
    expect(body["models"]).toEqual([unpriced]);
  });

  it("loads the catalogue's own list when the entry declares no endpoint to ask", async () => {
    const noUrl = { ...entry, baseUrl: null };
    const { fixture, invoke } = mount(bridge({ "catalog.models": [priced] }));
    await fixture.whenStable();

    fixture.componentInstance.pick(noUrl);
    fixture.detectChanges();
    // Nothing is asked of the network while the form is open: the list waits
    // for the save, when the key — if there is one — is in hand.
    expect(calls(invoke, "catalog.models")).toHaveLength(0);
    expect(fixture.nativeElement.querySelector("[data-testid=provider-base-url]")).not.toBeNull();

    fixture.componentInstance.patch("baseUrl", "https://self-hosted.acme.test/v1");
    await fixture.componentInstance.save();

    // The list came from the catalogue entry itself, key or no key.
    expect(calls(invoke, "catalog.models")[0]![1]).toEqual({ entryId: "acme", apiKey: null });
    const body = calls(invoke, "provider.create")[0]![1] as Record<string, unknown>;
    expect(body["models"]).toEqual([priced]);
  });

  it("connects a local runtime with the models the server already listed", async () => {
    const { fixture, invoke } = mount(bridge());
    await fixture.whenStable();

    fixture.componentInstance.pickLocal(runtime);
    await fixture.componentInstance.save();

    // A runtime on this machine is not asked anything twice: its models came
    // with it, and no endpoint is discovered behind the form's back.
    expect(calls(invoke, "provider.discover")).toHaveLength(0);
    expect(calls(invoke, "catalog.models")).toHaveLength(0);
    const body = calls(invoke, "provider.create")[0]![1] as Record<string, unknown>;
    expect(body["models"]).toEqual([{
      id: "gemma3:12b", displayName: "gemma3:12b", contextWindow: null,
      priceIn: null, priceOut: null, capabilities: null,
    }]);
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
      .querySelector("[data-testid=entry-acme]") as HTMLElement;
    const refused = fixture.nativeElement
      .querySelector("[data-testid=entry-venice]") as HTMLElement | null;

    // Visible, because a name that vanishes from the list teaches nothing;
    // unpressable, because the sentence about it belongs here and not three
    // steps later, after a key has been pasted.
    expect(served.classList.contains("menu-disabled")).toBe(false);
    expect(refused).not.toBeNull();
    expect(refused!.classList.contains("menu-disabled")).toBe(true);
    refused!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.draft()).toBeNull();
  });
});
