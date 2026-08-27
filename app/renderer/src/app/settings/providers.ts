import { ChangeDetectionStrategy, Component, inject, OnDestroy, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective } from "@jsverse/transloco";
import type {
  CatalogEntry, CatalogState, LocalRuntime, Provider, ProviderModel, ProviderPreset, VerifyCode,
} from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";

/**
 * A provider being written.
 *
 * `kind` decides what the form asks for: a catalogue entry wants the key and
 * nothing else, a local runtime wants nothing at all, the compatible endpoint
 * wants a URL and, if the gateway has one, a key. No kind ever asks for a
 * model id: the models arrive, or they do not.
 *
 * `apiKey` starts empty on every open and is never filled from the store: the
 * renderer is not allowed to read a key, so there is nothing to prefill with.
 */
interface Draft {
  id: string | null;
  kind: "catalog" | "local" | "compatible" | "edit";
  name: string;
  route: string;
  baseUrl: string | null;
  apiKey: string;
  headers: Record<string, string>;
  options: Record<string, unknown>;
  catalogId: string | null;
  catalogAt: string | null;
  /** The compatible endpoint's URL, typed by hand because nobody knows it. */
  compatUrl: string;
  models: ProviderModel[];
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
  id: null, kind: "compatible", name: "", route: "openai-compatible", baseUrl: null,
  apiKey: "", headers: {}, options: {}, catalogId: null, catalogAt: null,
  compatUrl: "", models: [],
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
  /** Why finding models failed, as a code: the interface owns the words. */
  readonly failure = signal<string | null>(null);
  readonly finding = signal(false);

  readonly query = signal("");
  readonly entries = signal<CatalogEntry[]>([]);
  readonly runtimes = signal<LocalRuntime[]>([]);
  readonly catalogState = signal<CatalogState | null>(null);
  readonly refreshing = signal(false);
  readonly importing = signal(false);
  /** What the last catalogue action said: "updated", or why it did not. */
  readonly catalogOutcome = signal<string | null>(null);

  /** The last verification, per provider, so a result stays on the row it belongs to. */
  readonly verified = signal<Record<string, { ok: boolean; code?: VerifyCode; latencyMs?: number }>>({});
  readonly verifying = signal<string | null>(null);
  readonly chosenModel = signal<Record<string, string>>({});

  #ipc = inject(IpcService);
  #unsubscribe: Array<() => void> = [];

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

  /** 203 entries do not scroll: the list arrives only when something is typed. */
  async search(text: string): Promise<void> {
    this.query.set(text);
    this.entries.set(text.trim() === ""
      ? []
      : await this.#ipc.invoke("catalog.search", { query: text }));
  }

  pick(entry: CatalogEntry): void {
    this.failure.set(null);
    this.draft.set({
      ...BLANK,
      kind: "catalog",
      name: entry.name,
      route: entry.route,
      baseUrl: entry.baseUrl,
      options: { ...entry.options },
      catalogId: entry.id,
      // The date of the metadata this provider will carry, which is the
      // catalogue's date: the answer to "how old is this price?".
      catalogAt: this.catalogState()?.at ?? null,
    });
    // An entry with no URL to ask carries its list in the catalogue itself;
    // for a cloud provider that is the publisher's own list.
    if (entry.baseUrl === null) void this.findModels();
  }

  pickLocal(runtime: LocalRuntime): void {
    this.failure.set(null);
    this.draft.set({
      ...BLANK,
      kind: "local",
      name: runtime.name,
      route: "openai-compatible",
      baseUrl: runtime.baseUrl,
      // What the running server serves, which no catalogue can know.
      models: runtime.models.map((id) => ({
        id, displayName: id, contextWindow: null, priceIn: null, priceOut: null, capabilities: null,
      })),
    });
  }

  pickCompatible(): void {
    this.failure.set(null);
    this.draft.set({ ...BLANK, kind: "compatible" });
  }

  edit(provider: Provider): void {
    this.failure.set(null);
    this.draft.set({
      ...BLANK,
      kind: "edit",
      id: provider.id,
      name: provider.name,
      route: provider.route,
      baseUrl: provider.baseUrl,
      headers: { ...provider.headers },
      options: { ...provider.options },
      catalogId: provider.catalogId,
      catalogAt: provider.catalogAt,
      models: provider.models.map((model) => ({ ...model })),
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

  cancel(): void {
    this.draft.set(null);
    this.failure.set(null);
  }

  patch<K extends keyof Draft>(field: K, value: Draft[K]): void {
    this.draft.update((draft) => (draft === null ? draft : { ...draft, [field]: value }));
  }

  /**
   * The one network act of the form: the models arrive, or a code says why
   * they did not. The typed key crosses to the main process here, exactly as
   * it does at save, and never comes back.
   */
  async findModels(): Promise<void> {
    const draft = this.draft();
    if (draft === null || this.finding()) return;

    this.finding.set(true);
    this.failure.set(null);
    try {
      const key = draft.apiKey.trim() === "" ? null : draft.apiKey;
      const models = draft.kind === "catalog"
        ? await this.#ipc.invoke("catalog.models", { entryId: draft.catalogId!, apiKey: key })
        : await this.#ipc.invoke("provider.discover", {
          baseUrl: draft.kind === "compatible" ? draft.compatUrl : draft.baseUrl!,
          apiKey: key,
        });
      this.draft.update((form) => form === null ? form : { ...form, models });
    } catch (error) {
      this.failure.set((error as { code?: string }).code ?? "unknown");
    } finally {
      this.finding.set(false);
    }
  }

  /** The models come from somewhere else; the form can only wait for them. */
  invalid(draft: Draft): boolean {
    if (draft.kind === "compatible") {
      return draft.name.trim() === "" || draft.compatUrl.trim() === "";
    }
    if (draft.kind === "edit") return draft.name.trim() === "";
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
        const baseUrl = draft.kind === "compatible" ? draft.compatUrl.trim() : draft.baseUrl;
        await this.#ipc.invoke("provider.create", {
          name: draft.name.trim(),
          route: draft.route,
          baseUrl: baseUrl === null || baseUrl === "" ? null : baseUrl,
          headers: draft.headers,
          options: draft.options,
          catalogId: draft.catalogId,
          catalogAt: draft.catalogAt,
          models: draft.models,
          ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
        });
      }
      this.draft.set(null);
      await this.reload();
    } catch (error) {
      this.failure.set((error as { code?: string }).code ?? "unknown");
    } finally {
      this.saving.set(false);
    }
  }

  /** Clearing is deliberate and separate: no edit does it as a side effect. */
  async clearKey(provider: Provider): Promise<void> {
    await this.#ipc.invoke("provider.update", { id: provider.id, apiKey: null });
    await this.reload();
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
