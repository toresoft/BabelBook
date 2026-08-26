import { ChangeDetectionStrategy, Component, inject, OnDestroy, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective } from "@jsverse/transloco";
import type { Provider, ProviderModel, ProviderPreset, VerifyCode } from "../../../../shared/dto.js";
import { IpcService } from "../core/ipc.service";

/**
 * A provider being written, as the form holds it.
 *
 * `apiKey` starts empty on every open and is never filled from the store: the
 * renderer is not allowed to read a key, so there is nothing to prefill with.
 * Empty therefore means "leave whatever is there", which is also what the main
 * process does with an absent one.
 *
 * `headers` and `options` are carried without being editable here. They are
 * not decoration: the DeepSeek preset disables reasoning, and a form that
 * dropped them would send every chunk to a model that spends its whole output
 * budget thinking, bill it in full, and hand back nothing.
 */
interface Draft {
  id: string | null;
  name: string;
  route: string;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  options: Record<string, unknown>;
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
  id: null, name: "", route: "openai-compatible", baseUrl: "",
  apiKey: "", headers: {}, options: {}, models: [],
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
  readonly presets = signal<ProviderPreset[]>([]);
  readonly draft = signal<Draft | null>(null);
  readonly saving = signal(false);
  readonly failure = signal<string | null>(null);

  /** The last verification, per provider, so a result stays on the row it belongs to. */
  readonly verified = signal<Record<string, { ok: boolean; code?: VerifyCode; latencyMs?: number }>>({});
  readonly verifying = signal<string | null>(null);
  readonly chosenModel = signal<Record<string, string>>({});

  #ipc = inject(IpcService);
  #unsubscribe: Array<() => void> = [];

  constructor() {
    void this.reload();
    // Another window — or the run itself failing on a key — can change the
    // list. Reloading on the event keeps two open windows from disagreeing.
    this.#unsubscribe.push(this.#ipc.on("providers.changed", () => void this.reload()));
  }

  ngOnDestroy(): void {
    for (const off of this.#unsubscribe) off();
  }

  async reload(): Promise<void> {
    const [providers, presets] = await Promise.all([
      this.#ipc.invoke("providers.list", undefined),
      this.#ipc.invoke("providers.presets", undefined),
    ]);
    this.providers.set(providers);
    this.presets.set(presets);
  }

  startBlank(): void {
    this.failure.set(null);
    this.draft.set({ ...BLANK, models: [] });
  }

  startFromPreset(preset: ProviderPreset): void {
    this.failure.set(null);
    this.draft.set({
      id: null,
      name: preset.name,
      route: preset.route,
      baseUrl: preset.baseUrl ?? "",
      apiKey: "",
      headers: { ...preset.headers },
      options: { ...preset.options },
      // Copied, not shared: editing the draft's models must not edit the
      // preset the next new provider would start from.
      models: preset.models.map((model) => ({ ...model })),
    });
  }

  edit(provider: Provider): void {
    this.failure.set(null);
    this.draft.set({
      id: provider.id,
      name: provider.name,
      route: provider.route,
      baseUrl: provider.baseUrl ?? "",
      apiKey: "",
      headers: { ...provider.headers },
      options: { ...provider.options },
      models: provider.models.map((model) => ({ ...model })),
    });
  }

  failureKey(code: string): string {
    return FAILURE_KEYS[code] ?? "providers.failed";
  }

  cancel(): void {
    this.draft.set(null);
    this.failure.set(null);
  }

  patch<K extends keyof Draft>(field: K, value: Draft[K]): void {
    this.draft.update((draft) => (draft === null ? draft : { ...draft, [field]: value }));
  }

  addModel(): void {
    this.draft.update((draft) => draft === null ? draft : {
      ...draft,
      models: [...draft.models,
        { id: "", displayName: "", contextWindow: null, priceIn: null, priceOut: null }],
    });
  }

  patchModel(at: number, field: keyof ProviderModel, value: string): void {
    this.draft.update((draft) => {
      if (draft === null) return draft;
      const models = draft.models.map((model, index) => {
        if (index !== at) return model;
        if (field === "id" || field === "displayName") return { ...model, [field]: value };
        // A blank number is null, not zero: "no price declared" and "free" are
        // different facts, and showing a cost of zero for the first is a lie.
        return { ...model, [field]: value.trim() === "" ? null : Number(value) };
      });
      return { ...draft, models };
    });
  }

  removeModel(at: number): void {
    this.draft.update((draft) => draft === null ? draft
      : { ...draft, models: draft.models.filter((_, index) => index !== at) });
  }

  /** A provider with no name, no route or a nameless model cannot be resolved. */
  invalid(draft: Draft): boolean {
    return draft.name.trim() === ""
      || draft.route.trim() === ""
      || draft.models.some((model) => model.id.trim() === "");
  }

  async save(): Promise<void> {
    const draft = this.draft();
    if (draft === null || this.invalid(draft)) return;

    this.saving.set(true);
    this.failure.set(null);
    try {
      const body = {
        name: draft.name.trim(),
        route: draft.route.trim(),
        baseUrl: draft.baseUrl.trim() === "" ? null : draft.baseUrl.trim(),
        headers: draft.headers,
        options: draft.options,
        models: draft.models.map((model) => ({
          ...model, id: model.id.trim(), displayName: model.displayName.trim() || model.id.trim(),
        })),
      };

      if (draft.id === null) {
        await this.#ipc.invoke("provider.create",
          { ...body, ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }) });
      } else {
        // An empty field leaves the stored key alone. Sending "" instead would
        // log the user out of a working provider every time they fixed a typo
        // in its name.
        await this.#ipc.invoke("provider.update",
          { id: draft.id, ...body, ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }) });
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

  async remove(provider: Provider): Promise<void> {
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
