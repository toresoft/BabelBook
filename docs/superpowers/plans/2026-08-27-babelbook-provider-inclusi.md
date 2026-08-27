# Provider inclusi — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** L'applicazione spedisce i pacchetti provider che le servono, chiama i 199 provider che sa servire senza che l'utente installi nulla, e dice degli altri 4 che non li serve *prima* che vengano scelti.

**Architecture:** Un registro esplicito rotta → import statico, in un file solo, sostituisce la composizione `@ai-sdk/${route}` che oggi `resolveModel` fa su una stringa presa dal database. Il registro è l'unico posto in cui un nome di pacchetto è scritto: `resolveModel` lo consulta per caricare, e `routeOf` lo consulta all'inverso per tradurre l'`npm` del catalogo in una rotta. Le rotte esistenti non cambiano di un carattere, perché la rotta è metà della chiave di cache delle traduzioni.

**Tech Stack:** TypeScript, `ai@^7`, 23 pacchetti provider dell'AI SDK, esbuild, electron-builder, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-27-provider-inclusi-design.md`

## Global Constraints

- `ai@^7.0.83` dipende da `@ai-sdk/provider@4.0.8`. **Solo pacchetti che dipendono da `@ai-sdk/provider@4` possono entrare nel registro.** Un pacchetto sulla `3.x` non fallisce all'import: fallisce alla chiamata, e va escluso.
- **Le rotte dei 192 provider che oggi risolvono non devono cambiare di un carattere.** La rotta finisce verbatim nel `modelId`, che è la chiave di cache delle traduzioni: cambiarla farebbe ritradurre lavoro già pagato.
- **Nessuna migrazione del database.** La colonna `provider.route` conserva esattamente i valori che ha oggi.
- **`packages: "external"` in `app/esbuild.mjs` resta com'è.** Esiste per il binding nativo di `yauzl-promise`; smontarlo non è parte di questo lavoro.
- I 24 pacchetti vanno in `dependencies` di `app/package.json`, mai in `devDependencies`: `electron-builder` imbarca solo le dipendenze di produzione.
- Codice e commenti in inglese. Ogni stringa mostrata all'utente esiste in `app/locales/en.json` **e** `app/locales/it.json`.
- **Nessun test raggiunge la rete o spende nulla.** Costruire un oggetto-modello non chiama l'endpoint; chiamarlo sì, e nessun test lo fa.
- I comandi si lanciano dalla radice del repo, dove `npx vitest` trova la configurazione. Node 24.18.0 (`fnm use`).

---

### Task 1: Il registro dei pacchetti provider

Crea il file che elenca, una volta sola e per esteso, ogni pacchetto che l'applicazione spedisce. È il solo posto del codice in cui un nome di pacchetto è scritto.

**Files:**
- Create: `app/engine/backends/registry.ts`
- Create: `app/test/registry.test.ts`
- Modify: `app/package.json` (le 24 dipendenze)

**Interfaces:**
- Consumes: niente (primo task)
- Produces:
  - `interface ProviderPackage { readonly specifier: string; readonly load: () => Promise<unknown> }`
  - `type ProviderPackages = Readonly<Record<string, ProviderPackage>>`
  - `const PROVIDER_PACKAGES: ProviderPackages` — 24 voci, chiave = rotta
  - `function routeForPackage(npm: string): string | null` — l'indice inverso, `npm` → rotta

- [ ] **Step 1: Installa le 24 dipendenze**

Dalla radice del repo:

```bash
npm install -w app --save \
  ai@^7.0.83 \
  @ai-sdk/openai-compatible @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/azure \
  @ai-sdk/google @ai-sdk/google-vertex @ai-sdk/mistral @ai-sdk/groq \
  @ai-sdk/xai @ai-sdk/cohere @ai-sdk/perplexity @ai-sdk/togetherai \
  @ai-sdk/cerebras @ai-sdk/deepinfra @ai-sdk/vercel @ai-sdk/gateway \
  @ai-sdk/amazon-bedrock \
  @openrouter/ai-sdk-provider @qvac/ai-sdk-provider \
  @saladtechnologies-oss/ai-sdk-provider gitlab-ai-provider \
  ai-gateway-provider merge-gateway-ai-sdk-provider
```

Verifica che siano finite in `dependencies` e non in `devDependencies`:

```bash
python3 -c "import json;d=json.load(open('app/package.json'));print(sorted(d['dependencies']))"
```

Attesa: 24 nomi, `@babelbook/core` compreso — quindi 25 voci in tutto.

- [ ] **Step 2: Scrivi il test che fallisce**

`app/test/registry.test.ts`:

```typescript
import gzip from "node:zlib";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PROVIDER_PACKAGES, routeForPackage } from "../engine/backends/registry.ts";

/** The packages the catalogue names for the four providers on the old spec. */
const OLD_SPEC = [
  "@jerome-benoit/sap-ai-provider-v2",
  "@aihubmix/ai-sdk-provider",
  "watsonx-ai-provider",
  "venice-ai-sdk-provider",
];

async function catalogue(): Promise<Array<{ npm: string; api: string | null }>> {
  const bytes = await readFile("app/catalog/snapshot.json.gz");
  const json = gzip.gunzipSync(bytes).toString("utf8");
  return (JSON.parse(json) as { providers: Array<{ npm: string; api: string | null }> }).providers;
}

/**
 * The one place a package name is written.
 *
 * Everything else asks the registry. These tests hold the two properties that
 * make that safe: every package it names is really installed and really
 * exports a provider factory, and every package the catalogue names is either
 * in it or knowingly out of it.
 */
describe("the provider registry", () => {
  it("loads every package it names, and each exports a factory", async () => {
    const failures: string[] = [];

    for (const [route, entry] of Object.entries(PROVIDER_PACKAGES)) {
      try {
        const module = (await entry.load()) as Record<string, unknown>;
        const factories = Object.keys(module)
          .filter((key) => key.startsWith("create") && typeof module[key] === "function");
        if (factories.length === 0) failures.push(`${route} (${entry.specifier}): no create* export`);
      } catch (error) {
        failures.push(`${route} (${entry.specifier}): ${(error as Error).message}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("names a route for every package the catalogue serves, and none for the four on the old spec", async () => {
    const unmapped = new Set<string>();
    for (const provider of await catalogue()) {
      if (routeForPackage(provider.npm) === null) unmapped.add(provider.npm);
    }

    expect([...unmapped].sort()).toEqual([...OLD_SPEC].sort());
  });
});
```

- [ ] **Step 3: Lancialo e guardalo fallire**

```bash
npx vitest run app/test/registry.test.ts
```

Attesa: FAIL con `Failed to resolve import "../engine/backends/registry.ts"` — il file non esiste ancora.

- [ ] **Step 4: Scrivi il registro**

`app/engine/backends/registry.ts`:

```typescript
/**
 * Every provider package this application ships, named once.
 *
 * The alternative — composing `@ai-sdk/${route}` from a string read out of the
 * database — is what this file replaces. It could not reach a package outside
 * the `@ai-sdk` scope, so a third of the catalogue's publishers were offered
 * and then failed at verification; and it made the set of packages something
 * no build step could see, so none of them shipped.
 *
 * Written as thunks rather than top-level imports: naming them here must not
 * cost the start-up time of loading twenty-three packages nobody asked for.
 * Written as literal specifiers rather than a variable: a bundler and a
 * packager can both see a literal, and neither can see a name computed at
 * runtime.
 *
 * A package may enter this file only if it depends on `@ai-sdk/provider@4`,
 * the spec `ai@7` speaks. One built on the 3.x line imports cleanly and hands
 * back a model of a different shape, so the failure lands at the first call
 * rather than here.
 */

export interface ProviderPackage {
  /** The npm specifier, which messages name and the catalogue is matched on. */
  readonly specifier: string;
  /** A literal import, so the bundler and the packager both see the package. */
  readonly load: () => Promise<unknown>;
}

export type ProviderPackages = Readonly<Record<string, ProviderPackage>>;

/** The route is the key, and the route is what a model spec carries. */
export const PROVIDER_PACKAGES: ProviderPackages = {
  "openai-compatible": {
    specifier: "@ai-sdk/openai-compatible",
    load: () => import("@ai-sdk/openai-compatible"),
  },
  anthropic: { specifier: "@ai-sdk/anthropic", load: () => import("@ai-sdk/anthropic") },
  openai: { specifier: "@ai-sdk/openai", load: () => import("@ai-sdk/openai") },
  azure: { specifier: "@ai-sdk/azure", load: () => import("@ai-sdk/azure") },
  google: { specifier: "@ai-sdk/google", load: () => import("@ai-sdk/google") },
  "google-vertex": {
    specifier: "@ai-sdk/google-vertex",
    load: () => import("@ai-sdk/google-vertex"),
  },
  // A subpath of a package already here, not a package of its own: Vertex
  // serves Anthropic's models through an entry point of its own.
  "google-vertex-anthropic": {
    specifier: "@ai-sdk/google-vertex/anthropic",
    load: () => import("@ai-sdk/google-vertex/anthropic"),
  },
  mistral: { specifier: "@ai-sdk/mistral", load: () => import("@ai-sdk/mistral") },
  groq: { specifier: "@ai-sdk/groq", load: () => import("@ai-sdk/groq") },
  xai: { specifier: "@ai-sdk/xai", load: () => import("@ai-sdk/xai") },
  cohere: { specifier: "@ai-sdk/cohere", load: () => import("@ai-sdk/cohere") },
  perplexity: { specifier: "@ai-sdk/perplexity", load: () => import("@ai-sdk/perplexity") },
  togetherai: { specifier: "@ai-sdk/togetherai", load: () => import("@ai-sdk/togetherai") },
  cerebras: { specifier: "@ai-sdk/cerebras", load: () => import("@ai-sdk/cerebras") },
  deepinfra: { specifier: "@ai-sdk/deepinfra", load: () => import("@ai-sdk/deepinfra") },
  vercel: { specifier: "@ai-sdk/vercel", load: () => import("@ai-sdk/vercel") },
  gateway: { specifier: "@ai-sdk/gateway", load: () => import("@ai-sdk/gateway") },
  "amazon-bedrock": {
    specifier: "@ai-sdk/amazon-bedrock",
    load: () => import("@ai-sdk/amazon-bedrock"),
  },

  // Published outside the `@ai-sdk` scope. These are the ones the old
  // composition could not name at all; their routes are new, and no project
  // has ever translated with them, so no cache depends on the names chosen.
  openrouter: {
    specifier: "@openrouter/ai-sdk-provider",
    load: () => import("@openrouter/ai-sdk-provider"),
  },
  qvac: { specifier: "@qvac/ai-sdk-provider", load: () => import("@qvac/ai-sdk-provider") },
  salad: {
    specifier: "@saladtechnologies-oss/ai-sdk-provider",
    load: () => import("@saladtechnologies-oss/ai-sdk-provider"),
  },
  gitlab: { specifier: "gitlab-ai-provider", load: () => import("gitlab-ai-provider") },
  "ai-gateway": { specifier: "ai-gateway-provider", load: () => import("ai-gateway-provider") },
  "merge-gateway": {
    specifier: "merge-gateway-ai-sdk-provider",
    load: () => import("merge-gateway-ai-sdk-provider"),
  },
};

const BY_PACKAGE = new Map(
  Object.entries(PROVIDER_PACKAGES).map(([route, entry]) => [entry.specifier, route]),
);

/**
 * The route that serves a catalogue package, or null when none does.
 *
 * Null is an answer, not a failure: the catalogue is refreshed from the
 * network and may name a publisher this application does not ship. What
 * happens next is the caller's decision, and it is taken where the caller can
 * still see the endpoint's address.
 */
export function routeForPackage(npm: string): string | null {
  return BY_PACKAGE.get(npm) ?? null;
}
```

- [ ] **Step 5: Lancialo e guardalo passare**

```bash
npx vitest run app/test/registry.test.ts
```

Attesa: PASS, 2 test.

Se il primo test elenca un pacchetto senza `create*`, quel pacchetto va **tolto dal registro e dalle dipendenze** e il suo `npm` va aggiunto a `OLD_SPEC` nel test: la specifica lo dà per compatibile, i suoi export dicono altro, e vince ciò che si è misurato. Lo spec segnala `merge-gateway-ai-sdk-provider` come il candidato più probabile.

- [ ] **Step 6: Commit**

```bash
git add app/package.json package-lock.json app/engine/backends/registry.ts app/test/registry.test.ts
git commit -m "feat(engine): i pacchetti provider che l'applicazione spedisce, nominati una volta sola"
```

---

### Task 2: `resolveModel` consulta il registro invece di comporre un nome

Toglie l'ultima composizione di stringhe dal percorso che decide quale codice verrà eseguito, e dà un codice proprio alla rotta che il registro non conosce.

**Files:**
- Modify: `app/engine/backends/resolve.ts:38-52` (`ModuleLoader`, `ResolveDeps`), `:125-171` (`resolveModel`)
- Modify: `app/test/resolve.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_PACKAGES`, `ProviderPackages`, `ProviderPackage` da `registry.ts`
- Produces:
  - `ResolveDeps.packages?: ProviderPackages` — il registro, iniettabile; assente significa quello vero
  - `ResolveDeps.load` **rimosso**
  - nuovo codice `ModelSpecError`: `UNSUPPORTED_ROUTE`

- [ ] **Step 1: Scrivi i test che falliscono**

In `app/test/resolve.test.ts`, sostituisci `fakeModule`/`load` in cima al file con un registro finto, e aggiungi i due test nuovi in coda a `describe("resolveModel", …)`:

```typescript
import { PROVIDER_PACKAGES } from "../engine/backends/registry.ts";

const fakeModule = { createAcme: (opts: unknown) => (id: string) => ({ id, opts }) };
const packages = {
  acme: { specifier: "@ai-sdk/acme", load: async () => fakeModule },
  broken: {
    specifier: "@ai-sdk/broken",
    load: async () => { throw new Error("Cannot find package '@ai-sdk/broken'"); },
  },
};
```

```typescript
it("refuses a route the registry does not name, before anything is loaded", async () => {
  await expect(resolveModel("nowhere:m1", { packages, apiKey: "k", baseUrl: null }))
    .rejects.toThrow(/UNSUPPORTED_ROUTE/);
});

it("finds a factory for every route the registry names", async () => {
  const failures: string[] = [];

  for (const route of Object.keys(PROVIDER_PACKAGES)) {
    try {
      // A key that is never used: building a model does not call the endpoint,
      // and no test of this suite may.
      const resolved = await resolveModel(`${route}:a-model`, {
        apiKey: "not-a-real-key", baseUrl: null,
      });
      expect(resolved.modelId).toBe(`${route}:a-model`);
    } catch (error) {
      // FACTORY_FAILED is an allowed answer, and the reason this test asserts
      // on codes rather than on success: Bedrock wants a region, Vertex a
      // project, and refusing a model without them is correct behaviour. That
      // refusal still proves what is being tested — the package loaded and its
      // factory was found. UNSUPPORTED_ROUTE or PACKAGE_MISSING would not.
      const code = (error as { code?: string }).code;
      if (code !== "FACTORY_FAILED") {
        failures.push(`${route}: ${code ?? "?"} — ${(error as Error).message}`);
      }
    }
  }

  expect(failures).toEqual([]);
});
```

Aggiorna anche le chiamate `resolveModel` già presenti nel file: dove passavano `load`, passano `packages`.

- [ ] **Step 2: Lanciali e guardali fallire**

```bash
npx vitest run app/test/resolve.test.ts
```

Attesa: FAIL. Il primo test riporta `PACKAGE_MISSING` invece di `UNSUPPORTED_ROUTE`; il secondo elenca ogni rotta, perché `deps.load` è ora assente e `resolveModel` lo invoca.

- [ ] **Step 3: Fai consultare il registro a `resolveModel`**

In `app/engine/backends/resolve.ts`, elimina `ModuleLoader` e il campo `load`, e sostituiscili:

```typescript
import { PROVIDER_PACKAGES, type ProviderPackages } from "./registry.ts";

export interface ResolveDeps {
  /**
   * The packages this application ships, injected so a test can name its own.
   * Absent means the real registry, which is what production wants.
   */
  packages?: ProviderPackages;
  apiKey: string | null;
  baseUrl: string | null;
  headers?: Record<string, string>;
  options?: Record<string, unknown>;
}
```

Dentro `resolveModel`, sostituisci il blocco che compone `specifier` e carica:

```typescript
  const entry = (deps.packages ?? PROVIDER_PACKAGES)[route];
  if (entry === undefined) {
    // Not "the package is missing on this machine": this application does not
    // serve this provider, and saying so is a different sentence with a
    // different remedy — an endpoint typed by hand, not an install.
    throw new ModelSpecError(
      "UNSUPPORTED_ROUTE", spec, `${route} is not a provider this application serves`,
    );
  }

  let module: Record<string, unknown>;
  try {
    module = (await entry.load()) as Record<string, unknown>;
  } catch {
    // Registry and package.json disagreeing is a build failure, not a state
    // the user can reach or repair; the code stays so it is not silent.
    throw new ModelSpecError("PACKAGE_MISSING", spec, `${entry.specifier} is not installed`);
  }
```

Nei due messaggi di `findFactory` e in quello di `FACTORY_FAILED`, sostituisci `@ai-sdk/${route}` con lo `specifier` della voce. `findFactory` prende un parametro in più:

```typescript
function findFactory(
  module: Record<string, unknown>, route: string, specifier: string, spec: string,
): Factory {
```

- [ ] **Step 4: Lanciali e guardali passare**

```bash
npx vitest run app/test/resolve.test.ts app/test/registry.test.ts
```

Attesa: PASS. Il secondo test nuovo è la prova che `findFactory` regge sui sei pacchetti fuori dallo scope `@ai-sdk`, e che ogni factory accetta di costruire un modello.

- [ ] **Step 5: Commit**

```bash
git add app/engine/backends/resolve.ts app/test/resolve.test.ts
git commit -m "feat(engine): la rotta si cerca nel registro, non si compone in un nome di pacchetto"
```

---

### Task 3: Il catalogo traduce `npm` in rotta col registro, e ammette di non saperlo

`routeOf` smette di togliere un prefisso e diventa una ricerca. Una voce che nessuna rotta serve resta nel catalogo con `route: null`, perché sparire silenziosamente è il difetto che questo lavoro corregge.

**Files:**
- Modify: `app/main/catalog/shape.ts:60-63` (`routeOf`)
- Modify: `app/main/catalog/service.ts:19-30` (`toEntry`)
- Modify: `app/shared/dto.ts:369-377` (`CatalogEntry.route`)
- Modify: `app/test/catalog.test.ts`

**Interfaces:**
- Consumes: `routeForPackage` da `registry.ts`
- Produces:
  - `routeOf(npm: string, api: string | null): string | null`
  - `CatalogEntry.route: string | null`

- [ ] **Step 1: Scrivi i test che falliscono**

In coda a `app/test/catalog.test.ts`:

```typescript
import gzip from "node:zlib";
import { readFile } from "node:fs/promises";
import { routeOf } from "../main/catalog/shape.ts";

async function providers(): Promise<Array<{ name: string; npm: string; api: string | null }>> {
  const json = gzip.gunzipSync(await readFile("app/catalog/snapshot.json.gz")).toString("utf8");
  return (JSON.parse(json) as { providers: Array<{ name: string; npm: string; api: string | null }> })
    .providers;
}

describe("the route a catalogue entry takes", () => {
  it("does not move a single route that already resolved, because the cache is keyed on it", async () => {
    // The spec `openai:gpt-5` is the modelId a translation was cached under.
    // A route that changes name makes a paid-for book translate itself again.
    for (const provider of await providers()) {
      if (!provider.npm.startsWith("@ai-sdk/")) continue;
      const legacy = provider.npm.slice("@ai-sdk/".length);
      if (legacy.includes("/")) continue; // never resolved: the regex refused it
      expect(routeOf(provider.npm, provider.api)).toBe(legacy);
    }
  });

  it("serves an unknown package through openai-compatible when the catalogue knows its address", () => {
    expect(routeOf("some-new-publisher", "https://example.test/v1")).toBe("openai-compatible");
  });

  it("says it cannot serve an unknown package with no address", () => {
    expect(routeOf("some-new-publisher", null)).toBeNull();
  });

  it("leaves exactly the four on the old spec unserved", async () => {
    const unserved = (await providers())
      .filter((provider) => routeOf(provider.npm, provider.api) === null)
      .map((provider) => provider.name)
      .sort();

    expect(unserved).toEqual(["AIHubMix", "SAP AI Core", "Venice AI", "watsonx.ai"]);
  });
});
```

- [ ] **Step 2: Lanciali e guardali fallire**

```bash
npx vitest run app/test/catalog.test.ts
```

Attesa: FAIL. `routeOf` prende un solo argomento, quindi i test del ripiego ricevono la stringa `"some-new-publisher"` invece di `"openai-compatible"` e di `null`.

- [ ] **Step 3: Riscrivi `routeOf`**

In `app/main/catalog/shape.ts`, sostituisci la funzione:

```typescript
import { routeForPackage } from "../../engine/backends/registry.ts";

/**
 * The route that will serve a catalogue entry, or null when none will.
 *
 * Three answers, in order. The registry knows the package: that route. It does
 * not, but the catalogue knows an address: `openai-compatible` reaches
 * anything that speaks the protocol, and most publishers outside the SDK do.
 * Neither: null, and the list says so where the choice is made — which beats a
 * key configured, a button pressed, and a sentence about a package.
 *
 * The address matters because it is the one thing `openai-compatible` cannot
 * invent. Twenty-two providers this application does serve have none either;
 * their own package carries its endpoint, so they never needed one.
 */
export function routeOf(npm: string, api: string | null): string | null {
  const known = routeForPackage(npm);
  if (known !== null) return known;
  return api === null || api === "" ? null : "openai-compatible";
}
```

In `app/main/catalog/service.ts`, `toEntry` passa l'indirizzo e regge il null:

```typescript
function toEntry(provider: CatalogProvider): CatalogEntry {
  const route = routeOf(provider.npm, provider.api);
  return {
    id: provider.id,
    name: provider.name,
    route,
    baseUrl: provider.api,
    options: route === null ? {} : routeDefaults(route),
    models: provider.models.length,
  };
}
```

In `app/shared/dto.ts`, `CatalogEntry`:

```typescript
  /** Null when this application serves no route for the entry's publisher. */
  route: string | null;
```

- [ ] **Step 4: Lanciali e guardali passare**

```bash
npx vitest run app/test/catalog.test.ts app/test/registry.test.ts && npm run typecheck -w app
```

Attesa: i test passano. Il typecheck **fallisce** in `app/renderer/src/app/settings/providers.ts:164`, dove `entry.route` ora può essere nullo: è il Task 6, e va lasciato rosso fin lì. Annota l'errore e prosegui.

- [ ] **Step 5: Commit**

```bash
git add app/main/catalog/shape.ts app/main/catalog/service.ts app/shared/dto.ts app/test/catalog.test.ts
git commit -m "feat(catalog): la rotta di una voce si chiede al registro, e puo' non esserci"
```

---

### Task 4: Il codice che dice «questo provider non lo servo»

`package-missing` parla di una macchina e di un'installazione. Il caso nuovo parla dell'applicazione, e ha un rimedio diverso: un endpoint scritto a mano.

**Files:**
- Modify: `app/shared/dto.ts:400-402` (`VerifyCode`)
- Modify: `app/main/providers/verify.ts:37-46` (`SPEC_CODES`)
- Modify: `app/locales/en.json`, `app/locales/it.json`
- Modify: `app/test/verify.test.ts`

**Interfaces:**
- Consumes: il codice `UNSUPPORTED_ROUTE` di `ModelSpecError` (Task 2)
- Produces: `VerifyCode` con `"unsupported-provider"`; chiavi `verify.unsupported-provider` in entrambi i cataloghi

- [ ] **Step 1: Scrivi il test che fallisce**

In `app/test/verify.test.ts`, dentro il `describe` di `classifyError`:

```typescript
it("tells a provider this application does not serve from a package left uninstalled", () => {
  const unsupported = new ModelSpecError("UNSUPPORTED_ROUTE", "watsonx:m1", "not served");
  const missing = new ModelSpecError("PACKAGE_MISSING", "openai:gpt-5", "not installed");

  // The two have different remedies: one is an endpoint typed by hand, the
  // other is a build that shipped wrong. One sentence for both would send the
  // user looking for a terminal that is not there.
  expect(classifyError(unsupported)).toBe("unsupported-provider");
  expect(classifyError(missing)).toBe("package-missing");
});
```

`ModelSpecError` si importa da `../engine/backends/resolve.ts`.

- [ ] **Step 2: Lancialo e guardalo fallire**

```bash
npx vitest run app/test/verify.test.ts
```

Attesa: FAIL con `expected 'unknown' to be 'unsupported-provider'` — `UNSUPPORTED_ROUTE` non è in `SPEC_CODES`, quindi cade nel ramo finale.

- [ ] **Step 3: Aggiungi il codice**

`app/shared/dto.ts`:

```typescript
export type VerifyCode =
  | "missing-key" | "package-missing" | "unsupported-provider" | "unauthorized"
  | "unreachable" | "bad-spec" | "unknown";
```

`app/main/providers/verify.ts`, dentro `SPEC_CODES`:

```typescript
  UNSUPPORTED_ROUTE: "unsupported-provider",
```

`app/locales/it.json`, accanto a `verify.package-missing`:

```json
      "unsupported-provider": "babelBook non serve questo provider. Aggiungilo come endpoint compatibile, scrivendone l'indirizzo.",
```

`app/locales/en.json`:

```json
      "unsupported-provider": "babelBook does not serve this provider. Add it as a compatible endpoint, giving its address.",
```

- [ ] **Step 4: Lancialo e guardalo passare**

```bash
npx vitest run app/test/verify.test.ts app/test/locales.test.ts
```

Attesa: PASS. `locales.test.ts` è ciò che impedisce a una chiave di esistere in una lingua sola.

- [ ] **Step 5: Commit**

```bash
git add app/shared/dto.ts app/main/providers/verify.ts app/locales/en.json app/locales/it.json app/test/verify.test.ts
git commit -m "feat(providers): un provider non servito lo dice con parole proprie, non con quelle di un pacchetto assente"
```

---

### Task 5: Il processo principale e l'engine smettono di nascondere `ai` in una variabile

Due punti caricano l'SDK con `const aiModule = "ai"` per impedire a TypeScript di risolverlo — un accorgimento che aveva senso finché il pacchetto poteva mancare. Ora c'è, e nasconderlo costa solo i tipi.

**Files:**
- Modify: `app/main/main.ts:98-119` (`verify`)
- Modify: `app/engine/main.ts:70-85` (`backendFromSpec`)
- Modify: `app/test/engine-host.test.ts`

**Interfaces:**
- Consumes: `ResolveDeps` senza `load` (Task 2)
- Produces: nessuna interfaccia nuova

- [ ] **Step 1: Scrivi il test che fallisce**

In coda a `app/test/engine-host.test.ts`:

```typescript
import { generateText } from "ai";
import { readFile } from "node:fs/promises";

/**
 * The SDK is a dependency now, not a hope.
 *
 * Importing it by name is the whole assertion: this file does not compile, and
 * this test does not run, on a checkout where `ai` is not installed. The
 * source check beside it is what keeps the two call sites from drifting back
 * to a specifier held in a variable, which typechecks on any machine and
 * therefore proves nothing.
 */
describe("the SDK the run calls", () => {
  it("is imported by name and exports generateText", () => {
    expect(typeof generateText).toBe("function");
  });

  it("is not hidden behind a variable in either process", async () => {
    for (const path of ["app/main/main.ts", "app/engine/main.ts"]) {
      expect(await readFile(path, "utf8")).not.toContain('const aiModule = "ai"');
    }
  });
});
```

- [ ] **Step 2: Lancialo e guardalo fallire**

```bash
npx vitest run app/test/engine-host.test.ts
```

Attesa: FAIL sul secondo test, che trova `const aiModule = "ai"` in entrambi i file. Il primo passa già: il pacchetto è installato dal Task 1.

- [ ] **Step 3: Importa l'SDK e smetti di passare `load`**

In `app/engine/main.ts`, aggiungi in cima `import { generateText } from "ai";` e riscrivi `backendFromSpec`:

```typescript
async function backendFromSpec(spec: BackendSpec): Promise<LlmBackend> {
  if (spec.kind === "fake") return fakeBackend();

  const resolved = await resolveModel(spec.spec, {
    apiKey: spec.apiKey,
    baseUrl: spec.baseUrl,
    ...(Object.keys(spec.headers).length === 0 ? {} : { headers: spec.headers }),
    options: spec.options,
  });
  return sdkBackend(resolved, generateText);
}
```

In `app/main/main.ts`, stesso import in cima, e dentro `verify` sostituisci il blocco che risolve e importa:

```typescript
    const resolved = await resolveModel(spec, {
      apiKey: readKey(glue.db, crypto, provider.id),
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      options: provider.options,
    });
    return await runVerification({ backend: sdkBackend(resolved, generateText), modelId: spec });
```

Togli da entrambi i file le righe `const aiModule = "ai"`, `const ai = await import(aiModule) …` e i commenti che le spiegavano: descrivono una premessa che non vale più.

- [ ] **Step 4: Lancialo e guardalo passare**

```bash
npx vitest run app/test/engine-host.test.ts && npm run typecheck -w app
```

Attesa: i test passano. Il typecheck resta rosso solo su `providers.ts:164`, che è il Task 6.

- [ ] **Step 5: Commit**

```bash
git add app/main/main.ts app/engine/main.ts app/test/engine-host.test.ts
git commit -m "feat(run): l'SDK e' una dipendenza, quindi si importa per nome"
```

---

### Task 6: La lista dice quali provider non sono servibili, prima che si scelgano

L'ultimo pezzo dell'obiettivo: i quattro restano visibili, dicono perché, e non si possono scegliere. È anche ciò che riporta il typecheck al verde.

**Files:**
- Modify: `app/renderer/src/app/settings/providers.ts:158-176` (`pick`)
- Modify: `app/renderer/src/app/settings/providers.html:111-119`
- Modify: `app/renderer/src/app/settings/providers.css`
- Modify: `app/locales/en.json`, `app/locales/it.json`
- Modify: `app/renderer/src/app/settings/providers.spec.ts`

**Interfaces:**
- Consumes: `CatalogEntry.route: string | null` (Task 3)
- Produces: nessuna interfaccia nuova

- [ ] **Step 1: Scrivi il test che fallisce**

In `app/renderer/src/app/settings/providers.spec.ts`, in coda al `describe("Providers", …)`. Usa `mount(bridge({…}))` e `fixture.componentInstance.search(…)`, come già fa `"finds providers by typing, not by scrolling"`:

```typescript
const unserved: CatalogEntry = {
  id: "venice", name: "Venice AI", route: null, baseUrl: null, options: {}, models: 3,
};

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
```

`entry` e `catalog` sono già in cima al file; `unserved` va accanto a `entry`.

- [ ] **Step 2: Lancialo e guardalo fallire**

```bash
npx ng test --project renderer
```

Da eseguire dentro `app/`. Attesa: FAIL con `expected false to be true` — il bottone non è ancora disabilitato.

- [ ] **Step 3: Marca le voci non servibili**

`app/renderer/src/app/settings/providers.html`, il ciclo delle voci:

```html
      @for (entry of entries(); track entry.id) {
        <button
          type="button"
          class="providers__entry"
          [class.providers__entry--unserved]="entry.route === null"
          [disabled]="entry.route === null"
          [attr.title]="entry.route === null ? t('providers.unserved') : null"
          [attr.data-testid]="'entry-' + entry.id"
          (click)="pick(entry)">
          {{ entry.name }}
        </button>
      }
```

`app/renderer/src/app/settings/providers.ts`, in cima a `pick`, così il null non entra mai in una bozza:

```typescript
  pick(entry: CatalogEntry): void {
    // The button is disabled, and this is the same fact said where the type
    // can hold it: a draft has a route, and an entry may not have one.
    if (entry.route === null) return;
```

`app/renderer/src/app/settings/providers.css`, accanto alle altre regole delle pill:

```css
.providers__entry--unserved { color: var(--text-faint); border-style: dashed; }
```

`app/locales/it.json`, sotto `providers`:

```json
    "unserved": "babelBook non serve questo provider: aggiungilo come endpoint compatibile, scrivendone l'indirizzo.",
```

`app/locales/en.json`:

```json
    "unserved": "babelBook does not serve this provider: add it as a compatible endpoint, giving its address.",
```

- [ ] **Step 4: Lancialo e guardalo passare**

Da `app/`:

```bash
npx ng test --project renderer
```

Poi, dalla radice:

```bash
npm run typecheck && npm test -w core && npm test -w app
```

Attesa: tutto verde, typecheck compreso. È qui che l'errore su `providers.ts:164` annotato al Task 3 sparisce.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/settings app/locales/en.json app/locales/it.json
git commit -m "feat(ui): i provider che non serviamo lo dicono nella lista, non dopo la verifica"
```

---

### Task 7: La prova che i pacchetti sono nel pacchetto

Ventiquattro dipendenze in `package.json` e ventiquattro dipendenze dentro un `.deb` sono fatti diversi, e tutto ciò che precede conosce solo il primo. `packaged.spec.ts` esiste per questa distinzione e salta ovunque tranne che in `release.yml`.

**Files:**
- Modify: `app/e2e/packaged.spec.ts`

**Interfaces:**
- Consumes: tutto quanto sopra
- Produces: nessuna interfaccia nuova

- [ ] **Step 1: Aggiungi al test l'asserzione che riguarda questo lavoro**

`packaged.spec.ts` oggi apre il pacchetto e gli fa leggere un libro. Aggiungi in coda al test, prima di `app.close()`, la verifica che l'SDK sia davvero dentro l'archivio:

```typescript
  // Reading a book proves the native binding shipped; it says nothing about
  // the provider packages, which no phase before a run ever touches. This
  // asks the packaged main process to load one, which is the same act a
  // verification performs.
  const loaded = await app.evaluate(async () => {
    const sdk = await import("ai");
    const provider = await import("@ai-sdk/openai-compatible");
    return typeof sdk.generateText === "function"
      && Object.keys(provider).some((key) => key.startsWith("create"));
  });
  expect(loaded).toBe(true);
```

Due dipendenze di produzione caricate per nome dal processo principale impacchettato: è lo stesso atto che compie una verifica, e non dipende da come `dist/` è disposto dentro l'asar.

- [ ] **Step 2: Costruisci il pacchetto e lancia il test**

Dalla radice:

```bash
npm run build -w app
cd app && npx electron-builder --linux dir --publish never
```

Poi:

```bash
BABELBOOK_PACKAGED=release/linux-unpacked/babelbook \
  xvfb-run --auto-servernum npx playwright test e2e/packaged.spec.ts
```

Attesa: 1 passed. **Se salta**, `BABELBOOK_PACKAGED` non punta a un file esistente: correggi il percorso invece di considerare il test superato — un test che salta non è un test che passa.

- [ ] **Step 3: Misura di quanto è cresciuto il pacchetto**

```bash
du -sh app/release/linux-unpacked
```

Attesa: circa 28 MB in più della misura precedente. Se è molto di più, un pacchetto si è portato dietro dipendenze impreviste e va guardato prima di proseguire.

- [ ] **Step 4: Commit**

```bash
git add app/e2e/packaged.spec.ts
git commit -m "test(e2e): il pacchetto costruito carica davvero un pacchetto provider"
```

---

## Verifica finale

Prima di dire fatto, dalla radice del repo:

```bash
npm run typecheck
npm test -w core
npm test -w app
cd app && xvfb-run --auto-servernum npm run test:e2e
```

E il fatto che nessuno dei comandi qui sopra dimostra, dal Task 7:

```bash
BABELBOOK_PACKAGED=release/linux-unpacked/babelbook \
  xvfb-run --auto-servernum npx playwright test e2e/packaged.spec.ts
```

Quello che questo lavoro **non** dimostra, e che nessun test può dimostrare senza spendere: che un endpoint risponda davvero. Lo dice la Verifica, in mano a chi ha una chiave.
