import { ChangeDetectionStrategy, Component, inject, OnDestroy, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective } from "@jsverse/transloco";
import type {
  CatalogEntry, CatalogState, LocalRuntime, Provider, ProviderModel, ProviderPreset, VerifyCode,
} from "../../../../shared/dto.js";
import { POPULAR } from "../../../../main/catalog/popular.js";
import { IpcService } from "../core/ipc.service";

/**
 * A provider being connected.
 *
 * What the form asks is a property of the provider, not a mode of the form.
 * The four kinds this replaced — catalogue, local, compatible, edit — cost
 * five conditions in the template to ask, in the end, for a key and sometimes
 * an address. An address is wanted only of the hand-typed endpoint: a
 * catalogue pick's address is the entry's own business (its package carries
 * it, or the catalogue declares it), and an edit was already given one. A key
 * is wanted unless the endpoint runs on this machine.
 *
 * `apiKey` starts empty on every open and is never filled from the store: the
 * renderer is not allowed to read a key, so there is nothing to prefill with.
 */
interface Draft {
  id: string | null;
  name: string;
  route: string;
  baseUrl: string | null;
  apiKey: string;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  catalogId: string | null;
  catalogAt: string | null;
  /** Carried, not asked: a runtime's own models, or an edit's untouched list. */
  models: ProviderModel[];
  /**
   * Whether the form must ask for an address. Only the hand-typed endpoint's
   * question: a catalogue pick never answers it — the entry's package carries
   * the endpoint or the catalogue declares it, and a URL typed over either
   * would override the real one at resolve time — and an edit was already
   * given its address by whoever created the provider.
   */
  needsUrl: boolean;
  /** A runtime on this machine wants no key; everything else does. */
  needsKey: boolean;
  /**
   * The variable this provider's key usually lives in, carried from the
   * catalogue entry so Task 6 can ask whether it holds anything. Null for a
   * local runtime and for a hand-typed endpoint, which have no documentation
   * to name one.
   */
  envVar: string | null;
  /** Whether the edited provider already had a key: "leave empty to keep it". */
  hadKey: boolean;
}

/**
 * The reasons worth their own sentence.
 *
 * "It could not be saved" is the message that sends a user to look at the
 * form, when the fault is that the operating system keyring is not reachable
 * and no amount of retyping will help. Anything not named here keeps the
 * generic sentence, which is honest: we do not know.
 */
const FAILURE_KEYS: Record<string, string> = {
  KEYRING_UNAVAILABLE: "providers.keyringUnavailable",
  PROVIDER_UNKNOWN: "providers.gone",
};

const BLANK: Draft = {
  id: null, name: "", route: "openai-compatible", baseUrl: null,
  apiKey: "", headers: {}, options: {}, catalogId: null, catalogAt: null,
  models: [], needsUrl: true, needsKey: true, envVar: null, hadKey: false,
};

@Component({
  selector: "bb-providers",
  standalone: true,
  imports: [FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./providers.html",
  styleUrl: "./providers.css",
})
export class Providers implements OnDestroy {
  readonly providers = signal<Provider[]>([]);
  readonly draft = signal<Draft | null>(null);
  readonly saving = signal(false);
  /** Why the last connect or find failed, as a code: the interface owns the words. */
  readonly failure = signal<string | null>(null);

  readonly query = signal("");
  readonly entries = signal<CatalogEntry[]>([]);
  readonly runtimes = signal<LocalRuntime[]>([]);
  /** Whether the connect dialog is showing. */
  readonly connecting = signal(false);
  readonly catalogState = signal<CatalogState | null>(null);
  readonly refreshing = signal(false);
  readonly importing = signal(false);
  /** What the last catalogue action said: "updated", or why it did not. */
  readonly catalogOutcome = signal<string | null>(null);

  /** The last verification, per provider, so a result stays on the row it belongs to. */
  readonly verified = signal<Record<string, { ok: boolean; code?: VerifyCode; latencyMs?: number }>>({});
  readonly verifying = signal<string | null>(null);
  readonly chosenModel = signal<Record<string, string>>({});
  /**
   * Whether the variable the current draft's entry names holds a key. Asked
   * once per draft, and only of drafts that name a variable; false for every
   * other draft. What it never holds is the key itself: the answer is the
   * channel's boolean, and the value stays on the main side.
   */
  readonly foundInEnv = signal(false);
  /** Whether the user accepted the offer to save the key the environment holds. */
  readonly useEnvKey = signal(false);

  #ipc = inject(IpcService);
  #unsubscribe: Array<() => void> = [];
  /** Monotonic id of the newest search: an older answer must not land. */
  #searchSeq = 0;

  constructor() {
    void this.reload();
    void this.probeLocals();
    // Another window — or the run itself failing on a key — can change the
    // list. Reloading on the event keeps two open windows from disagreeing.
    this.#unsubscribe.push(this.#ipc.on("providers.changed", () => void this.reload()));
  }

  ngOnDestroy(): void {
    for (const off of this.#unsubscribe) off();
  }

  async reload(): Promise<void> {
    const [providers, state] = await Promise.all([
      this.#ipc.invoke("providers.list", undefined),
      this.#ipc.invoke("catalog.state", undefined),
    ]);
    this.providers.set(providers);
    this.catalogState.set(state);
  }

  /** Local runtimes appear before any search is typed: they are already known. */
  async probeLocals(): Promise<void> {
    this.runtimes.set(await this.#ipc.invoke("local.runtimes", undefined));
  }

  /**
   * Asks the network for a newer catalogue, on request only. A failed
   * refresh is answered with a line, never with an alarm: the catalogue that
   * already works keeps answering, and the date line keeps saying its age.
   */
  async refreshCatalog(): Promise<void> {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.catalogOutcome.set(null);
    try {
      this.catalogState.set(await this.#ipc.invoke("catalog.refresh", undefined));
      this.catalogOutcome.set("updated");
    } catch {
      this.catalogOutcome.set("refreshFailed");
    } finally {
      this.refreshing.set(false);
    }
  }

  /** Carries a catalogue in from a file, for a machine without a network. */
  async importCatalog(): Promise<void> {
    if (this.importing()) return;
    this.importing.set(true);
    this.catalogOutcome.set(null);
    try {
      this.catalogState.set(await this.#ipc.invoke("catalog.importFile", undefined));
      this.catalogOutcome.set("updated");
    } catch (error) {
      this.catalogOutcome.set((error as { code?: string }).code === "BAD_CATALOG"
        ? "badImport"
        : "refreshFailed");
    } finally {
      this.importing.set(false);
    }
  }

  /**
   * The list follows the query, and the empty query is a question too: the
   * service answers it with the ten recommended, so clearing the field is a
   * return to the recommendation, not to nothing. 203 entries still do not
   * scroll: a typed query keeps getting a short list back.
   */
  async search(text: string): Promise<void> {
    this.query.set(text);
    // Latest call wins: the answer to an older query — the modal's opening
    // empty one, or a query the user already replaced — must not land.
    const seq = ++this.#searchSeq;
    try {
      const found = await this.#ipc.invoke("catalog.search", { query: text });
      if (seq === this.#searchSeq) this.entries.set(found);
    } catch {
      // A failed search keeps the list it had; the field still holds the
      // query that failed, and typing again retries it.
    }
  }

  /**
   * Opening the modal asks its opening question — the empty query — so the
   * ten are there before anything is typed, and the field starts over on
   * every open, like the key field below it does. The question rides the
   * same latest-wins guard as a typed one: a slow empty answer cannot
   * overwrite what the user already typed over it.
   */
  openConnect(): void {
    this.connecting.set(true);
    void this.search("");
  }

  closeConnect(): void {
    this.connecting.set(false);
  }

  /**
   * The recommended few, in the order they are recommended.
   *
   * The partition works on what the search returned; since the modal's
   * opening search is the empty one, this group holds all ten the moment it
   * opens. A typed query narrows it to the recommended that match, and an
   * entry the answer did not carry is skipped, not invented.
   */
  popular(): CatalogEntry[] {
    const found = new Map(this.entries().map((entry) => [entry.id, entry]));
    return POPULAR.flatMap((id) => {
      const entry = found.get(id);
      return entry === undefined ? [] : [entry];
    });
  }

  /** Everything the search found that is not one of the recommended, by name. */
  others(): CatalogEntry[] {
    return [...this.entries()]
      .filter((entry) => !POPULAR.includes(entry.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  pick(entry: CatalogEntry): void {
    // The row is marked unservable, and this is the same fact said where the
    // type can hold it: a draft has a route, and an entry may not have one.
    if (entry.route === null) return;
    // A choice closes the list: what follows belongs to the form, not to it.
    this.connecting.set(false);
    this.failure.set(null);
    this.#resetEnvOffer();
    this.draft.set({
      ...BLANK,
      name: entry.name,
      route: entry.route,
      baseUrl: entry.baseUrl,
      options: { ...entry.options },
      catalogId: entry.id,
      // The date of the metadata this provider will carry, which is the
      // catalogue's date: the answer to "how old is this price?".
      catalogAt: this.catalogState()?.at ?? null,
      // Never an address: a `baseUrl` of null on a pickable entry means the
      // publisher's own npm package carries the endpoint (the registry gave
      // the entry its route), not that nobody documented one. Asking here
      // would demand an address nobody has to give, and a typed value would
      // override the package's built-in endpoint and break every run.
      needsUrl: false,
      envVar: entry.envVar,
    });
    // The gift, when there is one: the variable the entry documents may
    // already hold a key, and the form says so instead of asking for a paste.
    if (entry.envVar !== null) void this.#askEnv(entry.envVar);
  }

  pickLocal(runtime: LocalRuntime): void {
    this.connecting.set(false);
    this.failure.set(null);
    this.#resetEnvOffer();
    this.draft.set({
      ...BLANK,
      name: runtime.name,
      route: "openai-compatible",
      baseUrl: runtime.baseUrl,
      // What the running server serves, which no catalogue can know.
      models: runtime.models.map((id) => ({
        id, displayName: id, contextWindow: null, priceIn: null, priceOut: null, capabilities: null,
      })),
      needsUrl: false,
      needsKey: false,
    });
  }

  pickCompatible(): void {
    this.connecting.set(false);
    this.failure.set(null);
    this.#resetEnvOffer();
    this.draft.set({ ...BLANK });
  }

  edit(provider: Provider): void {
    this.failure.set(null);
    this.#resetEnvOffer();
    this.draft.set({
      ...BLANK,
      id: provider.id,
      name: provider.name,
      route: provider.route,
      baseUrl: provider.baseUrl,
      headers: { ...provider.headers },
      options: { ...provider.options },
      catalogId: provider.catalogId,
      catalogAt: provider.catalogAt,
      models: provider.models.map((model) => ({ ...model })),
      // An edit never re-asks the address; it may still set a first key.
      needsUrl: false,
      hadKey: provider.hasKey,
    });
  }

  failureKey(code: string): string {
    return FAILURE_KEYS[code] ?? "providers.failed";
  }

  /** The codes discovery fails with have their own sentences; others get one. */
  discoverPhrase(code: string): string {
    return code === "unauthorized" || code === "unreachable" || code === "bad-response"
      ? `discover.${code}`
      : "providers.findFailed";
  }

  catalogOutcomeKey(outcome: string): string {
    return outcome === "updated" ? "providers.catalogUpdated"
      : outcome === "badImport" ? "providers.catalogBadImport"
      : "providers.catalogRefreshFailed";
  }

  /** Every draft starts with the environment's gift unopened. */
  #resetEnvOffer(): void {
    this.foundInEnv.set(false);
    this.useEnvKey.set(false);
  }

  /**
   * Asks, for the draft just opened, whether the variable its entry names
   * holds anything. Once per draft, and only of drafts that name a variable:
   * a compatible endpoint and a local runtime have no documentation to name
   * one, and the question would be about nothing.
   *
   * What is never asked is the opposite — whether a variable is *missing*.
   * An application launched from the desktop menu inherits no shell
   * environment, so absence says nothing about the user, and a sentence
   * about it would read as a reproach for something done right. The offer
   * appears when it is there, and the key field stands alone otherwise.
   */
  async #askEnv(envVar: string): Promise<void> {
    let found: boolean;
    try {
      found = await this.#ipc.invoke("env.hasKey", { name: envVar });
    } catch {
      // The offer is a gift, not a mechanism: a question that failed leaves
      // the form exactly as it was, key field and all.
      return;
    }
    // A draft opened while the question was in flight keeps its own answer:
    // the offer belongs to this draft, not to whichever draft was open last.
    if (this.draft()?.envVar === envVar) this.foundInEnv.set(found);
  }

  cancel(): void {
    this.draft.set(null);
    this.failure.set(null);
  }

  patch<K extends keyof Draft>(field: K, value: Draft[K]): void {
    this.draft.update((draft) => (draft === null ? draft : { ...draft, [field]: value }));
  }

  /**
   * What the form demands before it can save: a name for the one endpoint
   * nobody else can name — the hand-typed one, which is also the only one that
   * must be given an address. The key is never demanded — some gateways want
   * none — and no model id ever is: the models come from somewhere else; the
   * form can only carry them.
   */
  invalid(draft: Draft): boolean {
    if (draft.id !== null) return draft.name.trim() === "";
    if (draft.needsUrl) {
      return draft.name.trim() === "" || draft.baseUrl === null || draft.baseUrl.trim() === "";
    }
    return false;
  }

  async save(): Promise<void> {
    const draft = this.draft();
    if (draft === null || this.invalid(draft)) return;

    this.saving.set(true);
    this.failure.set(null);
    try {
      if (draft.id !== null) {
        // An edit names the name and, only when typed, the key. The models
        // are not the form's to rewrite: they came from the endpoint or the
        // catalogue, and an edit that erased them would be a surprise.
        await this.#ipc.invoke("provider.update", {
          id: draft.id,
          name: draft.name.trim(),
          ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
        });
      } else {
        // The models are asked for here, at the one moment the key is still
        // in hand: once the provider exists the key is written away for good,
        // and a list that needs it can no longer be fetched. A runtime on
        // this machine is the exception — its models arrived with it, and no
        // network is asked behind the form's back.
        const key = draft.apiKey.trim() === "" ? null : draft.apiKey;
        // The environment's key, when its offer was accepted: named, not
        // read. The window sends the variable's name and the main process
        // reads the value, because a key the window could read is a key it
        // could leak — and a name is documentation, not a secret. The typed
        // key still wins: a paste is the more deliberate act.
        const fromEnv = key === null && this.useEnvKey() && draft.envVar !== null
          ? { apiKeyFromEnv: draft.envVar }
          : {};
        const models = draft.catalogId !== null
          ? await this.#ipc.invoke("catalog.models", { entryId: draft.catalogId, apiKey: key, ...fromEnv })
          : draft.needsUrl && draft.baseUrl !== null
            ? await this.#ipc.invoke("provider.discover", { baseUrl: draft.baseUrl.trim(), apiKey: key, ...fromEnv })
            : draft.models;
        await this.#ipc.invoke("provider.create", {
          name: draft.name.trim(),
          route: draft.route,
          baseUrl: draft.baseUrl === null || draft.baseUrl.trim() === ""
            ? null
            : draft.baseUrl.trim(),
          headers: draft.headers,
          options: draft.options,
          catalogId: draft.catalogId,
          catalogAt: draft.catalogAt,
          models,
          ...(key === null ? fromEnv : { apiKey: draft.apiKey }),
        });
      }
      this.draft.set(null);
      await this.reload();
    } catch (error) {
      // A fetch that failed left nothing created: a provider connected
      // without its models is the half-state this screen refuses.
      this.failure.set((error as { code?: string }).code ?? "unknown");
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * How a connected provider authenticates, as a translation key.
   *
   * The store keeps no marker of the runtime a provider came from: all it has
   * is a route and an address. What a runtime does keep is the loopback
   * address it was probed on — and an endpoint on this machine is what
   * "Locale" means, whether the probe found it or a hand typed it. A remote
   * endpoint is its key, or the absence of one, and the absence is a fact
   * worth saying, not a lack to fix.
   */
  authKeyOf(provider: Provider): string {
    const base = provider.baseUrl ?? "";
    if (base.includes("//localhost") || base.includes("//127.")) return "providers.authLocal";
    return provider.hasKey ? "providers.authKey" : "providers.authNone";
  }

  /** The provider and its encrypted key go together, and only after the question. */
  async remove(provider: Provider): Promise<void> {
    const { confirmed } = await this.#ipc.invoke("ui.confirm", {
      kind: "deleteProvider",
      detail: { name: provider.name },
    });
    if (!confirmed) return;

    await this.#ipc.invoke("provider.delete", { id: provider.id });
    this.verified.update(({ [provider.id]: _gone, ...rest }) => rest);
    await this.reload();
  }

  modelFor(provider: Provider): string {
    return this.chosenModel()[provider.id] ?? provider.models[0]?.id ?? "";
  }

  chooseModel(provider: Provider, modelId: string): void {
    this.chosenModel.update((chosen) => ({ ...chosen, [provider.id]: modelId }));
  }

  /**
   * One minimal call to the endpoint, reported as a code.
   *
   * It is the only thing in this screen that spends anything, which is why it
   * is a button and not something the form does on save.
   */
  async verify(provider: Provider): Promise<void> {
    const modelId = this.modelFor(provider);
    if (modelId === "") return;

    this.verifying.set(provider.id);
    try {
      const outcome = await this.#ipc.invoke("provider.verify", { providerId: provider.id, modelId });
      this.verified.update((all) => ({ ...all, [provider.id]: outcome }));
    } catch {
      this.verified.update((all) => ({ ...all, [provider.id]: { ok: false, code: "unknown" } }));
    } finally {
      this.verifying.set(null);
    }
  }
}
