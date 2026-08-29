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

/**
 * An `api`-bearing entry, the shape of a publisher the SDK ships no package
 * for: the catalogue declares the address, and `routeOf` answers
 * `openai-compatible` because that protocol reaches anything that speaks it.
 */
const entry: CatalogEntry = {
  id: "acme", name: "Acme", route: "openai-compatible",
  baseUrl: "https://api.acme.test/v1", options: {}, models: 12,
  envVar: "ACME_API_KEY",
};

/**
 * An npm-route entry with a null api — the REAL Anthropic shape, taken from
 * the snapshot: the registry knows `@ai-sdk/anthropic`, and the package
 * carries its own endpoint, so the catalogue declares no address. `routeOf`
 * produces exactly this, and a null `baseUrl` on a pickable entry means
 * "documented in the package", never "unknown".
 */
const packaged: CatalogEntry = {
  id: "anthropic", name: "Anthropic", route: "anthropic",
  baseUrl: null, options: {}, models: 58,
  envVar: "ANTHROPIC_API_KEY",
};

const unserved: CatalogEntry = {
  id: "venice", name: "Venice AI", route: null, baseUrl: null, options: {}, models: 3,
  envVar: null,
};

const priced: ProviderModel = {
  id: "acme-mini", displayName: "Acme Mini", contextWindow: 128_000,
  priceIn: 0.5, priceOut: 2, capabilities: { toolCall: true, reasoning: false, structuredOutput: true, attachment: false },
  reasoningLevel: null,
};

const unpriced: ProviderModel = {
  id: "acme-other", displayName: "acme-other", contextWindow: null,
  priceIn: null, priceOut: null, capabilities: null, reasoningLevel: null,
};

const runtime: LocalRuntime = {
  id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "ollama", models: ["gemma3:12b"],
};

const state: CatalogState = {
  at: "2026-08-20T10:00:00.000Z", providers: 203, models: 7339, bundled: true,
  checkedAt: null,
};

/**
 * A provider as it comes back from the store: connected, keyed, priced. The
 * row tests spread it, so they differ in exactly the fact each one pins.
 */
const saved: Provider = {
  id: "p1", name: "Acme", route: "openai-compatible",
  baseUrl: "https://api.acme.test/v1", headers: {}, options: {},
  catalogId: "acme", catalogAt: "2026-08-20T10:00:00.000Z",
  models: [priced], hasKey: true,
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
    // The real ten are mostly npm-route entries with a null api — the
    // catalogue declares no address because the package carries it — so the
    // fixture wears that shape rather than an invented addressed one.
    const ten: CatalogEntry[] = POPULAR.map((id) => ({ ...packaged, id, name: id }));
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

  it("asks for the key, and nothing the catalogue already knows", async () => {
    const { fixture } = mount();
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector("[data-testid=provider-form]") as HTMLElement;

    expect(form.querySelector("[data-testid=provider-api-key]")).not.toBeNull();
    // No route to know, no URL to paste: the entry said so. The name it does
    // ask for is the entry's own, prefilled — there to be changed, not
    // invented.
    for (const absent of ["provider-route", "provider-base-url"]) {
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

  it("asks no address of a catalogue pick, and one only of the custom endpoint", async () => {
    const { fixture } = mount(bridge({ "catalog.search": [packaged] }));
    await fixture.whenStable();
    fixture.componentInstance.search("anthropic");
    await fixture.whenStable();
    fixture.detectChanges();

    // The honest pair. A catalogue pick is never asked for an address, not
    // even one whose entry declares none: a null api means the publisher's
    // own package carries the endpoint, and a URL typed here would override
    // the real one at resolve time and break every run. The custom endpoint
    // is the one endpoint nobody documented, so the address is its question
    // and only its question.
    fixture.nativeElement.querySelector("[data-testid=entry-anthropic]").click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=provider-base-url]")).toBeNull();
    expect(fixture.componentInstance.draft()?.needsUrl).toBe(false);

    fixture.componentInstance.pickCompatible();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=provider-base-url]")).not.toBeNull();
    expect(fixture.componentInstance.draft()?.needsUrl).toBe(true);
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
    // The name names the provider and the key unlocks it: no input carries a
    // model id.
    expect(
      form.querySelector(
        "input:not([data-testid=provider-api-key]):not([data-testid=provider-name])",
      ),
    ).toBeNull();

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
    const { fixture, invoke } = mount(bridge({ "catalog.models": [priced] }));
    await fixture.whenStable();

    // The packaged shape: the package carries the endpoint, the catalogue the
    // list. No address is asked of the form, and none is invented to ask with.
    fixture.componentInstance.pick(packaged);
    fixture.detectChanges();
    // Nothing is asked of the network while the form is open: the list waits
    // for the save, when the key — if there is one — is in hand.
    expect(calls(invoke, "catalog.models")).toHaveLength(0);
    expect(fixture.nativeElement.querySelector("[data-testid=provider-base-url]")).toBeNull();

    await fixture.componentInstance.save();

    // The list came from the catalogue entry itself, key or no key, and the
    // provider was created with the address it truly has: none of its own.
    expect(calls(invoke, "catalog.models")[0]![1]).toEqual({ entryId: "anthropic", apiKey: null });
    const body = calls(invoke, "provider.create")[0]![1] as Record<string, unknown>;
    expect(body["baseUrl"]).toBeNull();
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
      priceIn: null, priceOut: null, capabilities: null, reasoningLevel: null,
    }]);
  });

  it("offers the key the environment already holds, when the variable has one", async () => {
    const { fixture, invoke } = mount(bridge({ "env.hasKey": true }));
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    await fixture.whenStable();
    fixture.detectChanges();

    // One question per draft, about the variable the entry names — and a
    // boolean back, never the key itself.
    expect(calls(invoke, "env.hasKey")).toEqual([["env.hasKey", { name: "ACME_API_KEY" }]]);
    const offer = fixture.nativeElement.querySelector("[data-testid=use-env-key]");
    expect(offer).not.toBeNull();
    const said = (offer as HTMLElement).closest("label")!.textContent as string;
    expect(said).toContain(catalog.providers["foundInEnv"]!.replace("{{name}}", "ACME_API_KEY"));
  });

  it("asks nothing of the environment when the draft names no variable", async () => {
    const { fixture, invoke } = mount(bridge({ "env.hasKey": true }));
    await fixture.whenStable();

    fixture.componentInstance.pickCompatible();
    await fixture.whenStable();
    fixture.detectChanges();

    // A compatible endpoint and a local runtime have no documentation to
    // name a variable: the question is not asked, so no answer can put words
    // in the form.
    expect(calls(invoke, "env.hasKey")).toHaveLength(0);
    expect(fixture.nativeElement.querySelector("[data-testid=use-env-key]")).toBeNull();
  });

  it("says nothing when the variable holds no key: a gift, never a reproach", async () => {
    const { fixture } = mount(bridge({ "env.hasKey": false }));
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    await fixture.whenStable();
    fixture.detectChanges();

    // An app launched from the desktop menu inherits no shell environment:
    // absence is not the user's doing, and the interface never mentions it.
    expect(fixture.nativeElement.querySelector("[data-testid=use-env-key]")).toBeNull();
  });

  it("saves the key the environment holds when the offer is accepted", async () => {
    const { fixture, invoke } = mount(bridge({
      "env.hasKey": true,
      "catalog.models": [priced],
    }));
    await fixture.whenStable();

    fixture.componentInstance.pick(entry);
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.nativeElement.querySelector("[data-testid=use-env-key]")!.click();
    await fixture.componentInstance.save();

    // The window names the variable and types no key: the value is read on
    // the main side, the only side allowed to hold it.
    expect(calls(invoke, "catalog.models")[0]![1])
      .toEqual({ entryId: "acme", apiKey: null, apiKeyFromEnv: "ACME_API_KEY" });
    const body = calls(invoke, "provider.create")[0]![1] as Record<string, unknown>;
    expect(body["apiKeyFromEnv"]).toBe("ACME_API_KEY");
    expect("apiKey" in body).toBe(false);
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
    const { fixture, invoke } = mount(bridge({ "ui.confirm": { confirmed: false } }));
    await fixture.whenStable();

    await fixture.componentInstance.remove(saved);

    // The provider and its encrypted key go together; the question says which
    // one it is about to take.
    expect(calls(invoke, "ui.confirm")[0]![1]).toMatchObject({
      kind: "deleteProvider", detail: { name: "Acme" },
    });
    expect(calls(invoke, "provider.delete")).toHaveLength(0);
  });

  it("says of a connected provider how it is authenticated", async () => {
    const { fixture } = mount(bridge({ "providers.list": [{ ...saved, hasKey: true }] }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=auth-p1]").textContent)
      .toContain(catalog.providers["authKey"]);
  });

  it("says a provider on this machine is local, not one that merely lacks a key", async () => {
    const home: Provider = {
      ...saved, id: "p2", route: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1", catalogId: null, catalogAt: null, hasKey: false,
    };
    const bare: Provider = { ...saved, id: "p3", hasKey: false };
    const { fixture } = mount(bridge({ "providers.list": [home, bare] }));
    await fixture.whenStable();
    fixture.detectChanges();

    // The store keeps no marker of the runtime a provider came from: the
    // loopback address is the one fact left, and an endpoint on this machine
    // is what "Locale" says — never "Nessuna chiave", which reads as a lack.
    expect(fixture.nativeElement.querySelector("[data-testid=auth-p2]").textContent)
      .toContain(catalog.providers["authLocal"]);
    // A remote endpoint without a key is not local: it is a key nobody set.
    expect(fixture.nativeElement.querySelector("[data-testid=auth-p3]").textContent)
      .toContain(catalog.providers["authNone"]);
  });

  it("titles the connected as what they are", async () => {
    const { fixture } = mount(bridge({ "providers.list": [saved] }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=connected-title]").textContent)
      .toContain(catalog.providers["connectedTitle"]);
  });

  it("says nothing of connected providers when there are none", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    // No title over nothing: the empty line already says the one true thing.
    expect(fixture.nativeElement.querySelector("[data-testid=connected-title]")).toBeNull();
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

  /**
   * A switch on a model that cannot reason is a control that does nothing, and
   * a control that does nothing teaches people not to trust the others.
   */
  /** A model the catalogue says can reason, beside the one that cannot. */
  const thinker: ProviderModel = {
    ...priced, id: "acme-max", displayName: "Acme Max", reasoningLevel: null,
    capabilities: { toolCall: true, reasoning: true, structuredOutput: true, attachment: false },
  };

  it("offers the reasoning control only for a model that can reason", async () => {
    const { fixture } = mount(bridge({
      "providers.list": [{ ...saved, models: [thinker, { ...priced, reasoningLevel: null }] }],
    }));
    await fixture.whenStable();
    fixture.detectChanges();

    // The control follows the model chosen in the card's select, which starts
    // on the first — the one that reasons.
    expect(fixture.nativeElement.querySelector("[data-testid=reasoning-p1]")).not.toBeNull();

    const select = fixture.nativeElement.querySelector("[data-testid=verify-model-p1]");
    select.value = "acme-mini";
    select.dispatchEvent(new Event("change"));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=reasoning-p1]")).toBeNull();
  });

  /**
   * The switch changes the cache key, so it throws away what was translated with
   * that model. It says so before it does it — the same promise the terms screen
   * already keeps.
   */
  it("says what it would undo before undoing it", async () => {
    const invoke = bridge({
      "providers.list": [{ ...saved, models: [thinker] }],
      "ui.confirm": { confirmed: false },
    });
    const { fixture } = mount(invoke);
    await fixture.whenStable();
    fixture.detectChanges();

    const control = fixture.nativeElement.querySelector("[data-testid=reasoning-p1]");
    control.value = "high";
    control.dispatchEvent(new Event("change"));
    await fixture.whenStable();

    expect(calls(invoke, "ui.confirm")).toHaveLength(1);
    expect(calls(invoke, "provider.setReasoning")).toHaveLength(0);
  });

  /**
   * A refusal must leave the control saying what the store says: one that
   * moves on a "no" is as untrustworthy as one that does nothing.
   */
  it("leaves the control as it was when the change is refused", async () => {
    const { fixture } = mount(bridge({
      "providers.list": [{ ...saved, models: [thinker] }],
      "ui.confirm": { confirmed: false },
    }));
    await fixture.whenStable();
    fixture.detectChanges();

    const control = fixture.nativeElement.querySelector("[data-testid=reasoning-p1]") as HTMLSelectElement;
    control.value = "max";
    control.dispatchEvent(new Event("change"));
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector("[data-testid=reasoning-p1]") as HTMLSelectElement).value)
      .toBe("off");
  });

  /**
   * Production break: the control could say only whether to think. A book
   * translated with the thinking off — the only alternative there was — came
   * back a third of it in another language, and there was no way to ask for
   * less thinking rather than for none.
   */
  it("offers a strength, not only an on and an off", async () => {
    const { fixture } = mount(bridge({ "providers.list": [{ ...saved, models: [thinker] }] }));
    await fixture.whenStable();
    fixture.detectChanges();

    const control = fixture.nativeElement.querySelector("[data-testid=reasoning-p1]") as HTMLSelectElement;
    expect([...control.options].map((option) => option.value)).toEqual(["off", "low", "high", "max"]);
    // An unchosen model reads as off, the same way the run reads it.
    expect(control.value).toBe("off");
  });

  /** The yes reaches the store for the model the select points at. */
  it("changes the chosen model's reasoning, after the yes", async () => {
    const invoke = bridge({
      "providers.list": [{ ...saved, models: [thinker] }],
      "ui.confirm": { confirmed: true },
    });
    const { fixture } = mount(invoke);
    await fixture.whenStable();
    fixture.detectChanges();

    const control = fixture.nativeElement.querySelector("[data-testid=reasoning-p1]") as HTMLSelectElement;
    control.value = "low";
    control.dispatchEvent(new Event("change"));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(calls(invoke, "ui.confirm")[0]![1]).toMatchObject({
      kind: "reasoningChange", detail: { name: "Acme", model: "Acme Max" },
    });
    expect(calls(invoke, "provider.setReasoning")).toEqual([
      ["provider.setReasoning", { providerId: "p1", modelId: "acme-max", level: "low" }],
    ]);
  });

  /**
   * Two keys for the same brand — work and personal — used to become two rows
   * nobody could tell apart, both at the top under "connected".
   */
  it("asks for a name when connecting from the catalogue", async () => {
    const { fixture } = mount(bridge({ "catalog.search": [entry] }));
    await fixture.whenStable();

    // The same two clicks the modal's own tests make: open it, choose the entry.
    fixture.nativeElement.querySelector("[data-testid=open-connect]").click();
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.nativeElement.querySelector("[data-testid=entry-acme]").click();
    await fixture.whenStable();
    fixture.detectChanges();

    const field = fixture.nativeElement.querySelector("[data-testid=provider-name]");
    expect(field).not.toBeNull();
    expect(field.value).toBe(entry.name);
  });
});
