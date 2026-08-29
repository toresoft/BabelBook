# C — La schermata dei provider — piano di implementazione

**Stato: completo, 7 task su 7 + ondata finale di correzioni, al 2026-08-29.**

Commits: `3672685` (T1), `ffa0815` (T2), `2c04281` (T3), `2f63031`+`a91d5be` (T4: la modale e i dieci all'apertura), `b72ccfe` (voce non servita e ricerca che non si rincorre), `e8cf7ee` (T5), `66a952d` (T6), `93a78f6` (T7), `41e7fc5` (ondata finale). Chiusura verificata: typecheck pulito, suite verde (275 core, 365+119 app), e2e 8 superati + 1 saltato, ventisei schermate (le due della modale aperta comprese). La review finale dell'intero ramo aveva dato BLOCKED per un Critical di composizione: `needsUrl: entry.baseUrl === null` chiedeva un indirizzo inventato a otto dei dieci consigliati, perché nel catalogo reale `api: null` significa che il pacchetto npm porta l'endpoint dentro di sé — e un URL scritto a mano lì avrebbe sovrascritto quello vero alle esecuzioni. Il test del piano che lo chiedeva poggiava su una combinazione (route non nulla + api nulla) che `routeOf` non produce mai. L'ondata finale ha chiuso quello, ha vincolato `apiKeyFromEnv` al nome dichiarato dal catalogo (rifiutato sull'endpoint scritto a mano), ha messo la guardia `Object.hasOwn` alle due letture di `process.env` (il prototipo faceva mentire il booleano con nomi come `toString`) e ha spazzato i morti. Ogni task ha avuto la sua review.

Cosa l'esecuzione ha cambiato o scoperto, rispetto al piano scritto:

- **Il recupero dei modelli sta nel salvataggio.** Il piano toglieva il blocco modelli dal modulo senza dire dove i modelli arrivassero: la chiave non si rilegge, quindi la ricerca avviene mentre è ancora in mano — `save()` = fetch (catalogo o discover) + creazione, silenziosa; fetch fallita = frase nel modulo, nessuna creazione a metà. La `Draft` mantiene `headers` e `models` (dati trasportati, non modi del form) e guadagna `hadKey` per il segnaposto della chiave in modifica.
- **La ricerca vuota risponde coi dieci.** Il servizio si rifiutava di cercare la stringa vuota e la modale si apriva senza i consigliati: ora la query vuota restituisce i dieci in ordine di `POPULAR`, saltando gli id scomparsi (skip-not-fail, dichiarato nel commento). `search()` ha una guardia monotona: l'ultima risposta vince.
- **`menu-disabled` funziona su `<li>`, non sull'ancora** (daisyUI 5.7.22): la regola locale `.menu a.menu-disabled` fa da ponte, con il tooltip della voce non servita ripristinato.
- **«Rimuovi la chiave» non c'è più**: disconnettere è l'unico modo di togliere una chiave, e la frase di conferma lo dice («anche la sua chiave cifrata verrà rimossa»). L'etichetta «Locale» è derivata dall'indirizzo (`//localhost` o `//127.`), con i limiti documentati nel commento.
- **La chiave dell'ambiente passa per nome, mai per valore**: `env.hasKey` è un canale booleano; quando la casella è spuntata, la richiesta porta `apiKeyFromEnv` (il *nome* della variabile) e la risoluzione avviene in un solo punto main-side (`resolveKey`), col vincolo alla `env` dichiarata dalla voce di catalogo.
- **Il piano dava per esistente il montaggio della sua spec**: `catalog.providers["authKey"]` era un lookup nel locale, adattato all'harness; e i test verbatim del T1/T6 hanno preteso due correzioni meccaniche (la collisione dell'identificatore `it` con vitest; l'ombra TDZ in `deps()`).
- **Per il futuro:** `entryFacts` non pluralizza («1 modelli», come `glossaries.terms` e `library.progress` — famiglia di stringhe da portare alle ICU di transloco); `providers.empty` parla di una ricerca che ora sta nella modale; il canale `providers.presets` non ha consumatore; `authKeyOf` matcha `localhost.example.com` per sottostringa.
- **Ambiente:** `xvfb-run` assente (e2e su `DISPLAY=:0`), schermate mai commettate. L'altro worker ha lavorato in parallelo per tutto il piano su `core/`, `app/engine/` e la pipeline di esecuzione (reasoning-tokens, fallback esclusi dal avanzamento): ogni commit C lo esclude. Alla chiusura i suoi cammini e2e (gates, translate ×2) sono rossi nell'albero condiviso ma verdi a HEAD pulito — attribuzione provata per raggiungibilità; la sua suite unitaria è verde.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ciò che è collegato si distingue da ciò che si può aggiungere, collegare un provider e scegliere un modello tornano a essere due atti, e un provider si sceglie sapendo qualcosa di lui.

**Architecture:** Il modulo perde i suoi quattro `kind` perché perde uno dei due lavori che faceva: collegare chiede al massimo una chiave e un indirizzo, e quale delle due dipende dal provider, non da un modo del form. La scelta del modello si sposta sulla scheda del provider già collegato. La ricerca si sposta in una modale con tre gruppi, dove il provider personalizzato è una voce come le altre. I dieci consigliati sono scritti nel codice; per gli altri centonovanta la riga sotto il nome è derivata dal catalogo.

**Tech Stack:** Angular 22.1, daisyUI 5, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-27-provider-connessi-design.md`

## Global Constraints

- **Parte da un albero dove A e B1 sono atterrati.** A rende `CatalogEntry.route` nullabile — ed è già così — e B1 fornisce `modal`, `card`, `badge`, `menu`.
- **La chiave non arriva mai alla finestra.** È vero oggi e resta vero: la chiave si scrive e non si rilegge. I test che lo tengono non si toccano.
- **Nessun indirizzo inventato.** Se il catalogo non conosce l'`api` di un provider, questa applicazione non se lo scrive: è lo stesso principio per cui il catalogo non inventa i prezzi.
- **Il campo `env` non è un meccanismo.** Un'app Electron avviata dal menu applicazioni su Linux non eredita l'ambiente della shell. L'interfaccia non dice mai «manca la variabile d'ambiente»: dice «serve una chiave», e semmai aggiunge di averne trovata una.
- **Niente icone, niente OAuth.** Sono non-obiettivi dichiarati: le voci portano nome e riga, e l'autenticazione è solo per chiave.
- Ogni stringa esiste in `app/locales/en.json` **e** `app/locales/it.json`.
- Codice e commenti in inglese. Comandi dalla radice del repo salvo dove indicato. Node 24.18.0.

---

### Task 1: I dieci consigliati, con le loro frasi

Una lista scritta nel codice, non nel catalogo: è un fatto su cosa questa applicazione consiglia, non su cosa il catalogo contiene — la stessa ragione per cui `routeDefaults` vive in `providers/store.ts`.

**Files:**
- Create: `app/main/catalog/popular.ts`
- Modify: `app/locales/en.json`, `app/locales/it.json`
- Create: `app/test/popular.test.ts`

**Interfaces:**
- Consumes: lo snapshot in `app/catalog/snapshot.json.gz`
- Produces: `const POPULAR: readonly string[]` — dieci id del catalogo, nell'ordine in cui vanno mostrati

- [ ] **Step 1: Scrivi il test che fallisce**

`app/test/popular.test.ts`:

```typescript
import gzip from "node:zlib";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import it from "../locales/it.json";
import { POPULAR } from "../main/catalog/popular.ts";

async function ids(): Promise<Set<string>> {
  const json = gzip.gunzipSync(await readFile("app/catalog/snapshot.json.gz")).toString("utf8");
  return new Set((JSON.parse(json) as { providers: Array<{ id: string }> }).providers.map((p) => p.id));
}

/**
 * The ten this application recommends.
 *
 * A recommendation is an opinion, and opinions age — no test can say whether
 * these are still good first choices. What a test can say is that they still
 * exist and still have their sentence, so a catalogue refresh cannot quietly
 * remove one from under the screen.
 */
describe("the recommended providers", () => {
  it("are all still in the catalogue", async () => {
    const known = await ids();
    expect(POPULAR.filter((id) => !known.has(id))).toEqual([]);
  });

  it("each carry a sentence, in both languages", () => {
    const missing: string[] = [];
    for (const id of POPULAR) {
      for (const [lang, catalogue] of [["it", it], ["en", en]] as const) {
        const said = (catalogue as { popular?: Record<string, string> }).popular?.[id];
        if (said === undefined || said.trim() === "") missing.push(`${lang}: ${id}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Lancialo e guardalo fallire**

```bash
npx vitest run app/test/popular.test.ts
```

Attesa: FAIL, `Failed to resolve import "../main/catalog/popular.ts"`.

- [ ] **Step 3: Scrivi la lista e le venti frasi**

`app/main/catalog/popular.ts`:

```typescript
/**
 * The providers this application puts first.
 *
 * Not a catalogue fact: models.dev carries no notion of popularity, and this
 * is an opinion about what someone translating a book should try before the
 * other hundred and ninety. It lives in the code for the same reason
 * `routeDefaults` does — it is a statement about how this application behaves,
 * not about what the endpoint serves.
 *
 * The order is the order shown. A test holds that each is still in the
 * catalogue and still has its sentence; nothing can hold that it is still a
 * good answer, and that stays a decision to revisit.
 */
export const POPULAR: readonly string[] = [
  "anthropic", "openai", "google", "openrouter", "mistral",
  "groq", "xai", "deepseek", "togetherai", "cerebras",
];
```

In `app/locales/it.json`, una chiave `popular`:

```json
  "popular": {
    "anthropic": "I modelli Claude, direttamente da chi li fa.",
    "openai": "I modelli GPT, direttamente da chi li fa.",
    "google": "I modelli Gemini, direttamente da chi li fa.",
    "openrouter": "Un solo accesso a centinaia di modelli di provider diversi.",
    "mistral": "Modelli europei, con buona resa sulle lingue romanze.",
    "groq": "Risposte molto rapide su modelli aperti.",
    "xai": "I modelli Grok, direttamente da chi li fa.",
    "deepseek": "Modelli economici con buona resa sui testi lunghi.",
    "togetherai": "Molti modelli aperti su un solo endpoint.",
    "cerebras": "Modelli aperti serviti con latenza molto bassa."
  },
```

e in `app/locales/en.json` le stesse dieci, tradotte.

- [ ] **Step 4: Lancialo e guardalo passare**

```bash
npx vitest run app/test/popular.test.ts app/test/locales.test.ts
```

Attesa: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/main/catalog/popular.ts app/locales app/test/popular.test.ts
git commit -m "feat(catalog): i dieci provider che l'applicazione consiglia, con le loro frasi"
```

---

### Task 2: La riga derivata, e il campo `env` che nessuno guardava

`shape.ts` legge `env` per tutti e 203 i provider e `toEntry` lo scarta. Da qui in avanti arriva alla finestra.

**Files:**
- Modify: `app/shared/dto.ts` (`CatalogEntry`)
- Modify: `app/main/catalog/service.ts` (`toEntry`)
- Modify: `app/test/catalog.test.ts`

**Interfaces:**
- Consumes: `CatalogProvider.env`, `CatalogProvider.models` (esistenti)
- Produces: `CatalogEntry.envVar: string | null`

- [ ] **Step 1: Scrivi i test che falliscono**

In `app/test/catalog.test.ts`:

```typescript
describe("what an entry says about itself", () => {
  it("carries the name of the variable its key is usually in", () => {
    const [entry] = searchCatalog(aCatalog([
      { id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible",
        env: ["ACME_API_KEY"], api: "https://acme.test/v1", models: [] },
    ]), "acme");

    expect(entry!.envVar).toBe("ACME_API_KEY");
  });

  it("takes the first when a provider declares several", () => {
    // Google declares three. One name on a line is information; three is a
    // list nobody reads.
    const [entry] = searchCatalog(aCatalog([
      { id: "goog", name: "Goog", npm: "@ai-sdk/google",
        env: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
        api: null, models: [] },
    ]), "goog");

    expect(entry!.envVar).toBe("GOOGLE_API_KEY");
  });

  it("says null when a provider declares none", () => {
    const [entry] = searchCatalog(aCatalog([
      { id: "bare", name: "Bare", npm: "@ai-sdk/openai-compatible",
        env: [], api: "https://bare.test/v1", models: [] },
    ]), "bare");

    expect(entry!.envVar).toBeNull();
  });
});
```

`aCatalog(providers)` è un aiuto locale: avvolge l'array nella forma
`{ at: "2026-08-27T00:00:00.000Z", providers }`.

- [ ] **Step 2: Lanciali e guardali fallire**

```bash
npx vitest run app/test/catalog.test.ts
```

Attesa: FAIL, `Property 'envVar' does not exist on type 'CatalogEntry'`.

- [ ] **Step 3: Portalo fino alla finestra**

In `app/shared/dto.ts`:

```typescript
  /**
   * The variable the provider's documentation names for its key, when it names
   * one. Shown, never relied on: an application launched from a desktop menu
   * on Linux does not inherit the shell's environment, so a key exported in a
   * shell profile is simply not there.
   */
  envVar: string | null;
```

In `app/main/catalog/service.ts`, dentro `toEntry`:

```typescript
    envVar: provider.env[0] ?? null,
```

- [ ] **Step 4: Lanciali e guardali passare**

```bash
npx vitest run app/test/catalog.test.ts && npm run typecheck -w app
```

Attesa: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/shared/dto.ts app/main/catalog/service.ts app/test/catalog.test.ts
git commit -m "feat(catalog): la voce dice quanti modelli serve e in quale variabile sta la sua chiave"
```

---

### Task 3: Collegare smette di scegliere

Il cambiamento che porta via il disordine. Cinque condizioni su quattro modi diventano un modulo che chiede al massimo due cose.

**Files:**
- Modify: `app/renderer/src/app/settings/providers.ts`
- Modify: `app/renderer/src/app/settings/providers.html`
- Modify: `app/renderer/src/app/settings/providers.spec.ts`

**Interfaces:**
- Consumes: `provider.create`, `provider.update`, `catalog.models`, `provider.discover` — tutti esistenti
- Produces: `Draft` senza `kind`, con `needsUrl: boolean` e `needsKey: boolean`

- [ ] **Step 1: Scrivi i test che falliscono**

In `providers.spec.ts`:

```typescript
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
```

- [ ] **Step 2: Lanciali e guardali fallire**

Da `app/`: `npx ng test`. Attesa: FAIL — il modulo mostra ancora la lista dei
modelli subito dopo la scelta.

- [ ] **Step 3: Togli i quattro modi**

In `providers.ts`, `Draft` perde `kind` e guadagna due fatti:

```typescript
/**
 * A provider being connected.
 *
 * What the form asks is a property of the provider, not a mode of the form.
 * The four kinds this replaced — catalogue, local, compatible, edit — cost
 * five conditions in the template to ask, in the end, for a key and sometimes
 * an address. An address is wanted when the catalogue knows none; a key is
 * wanted unless the endpoint runs on this machine.
 */
interface Draft {
  id: string | null;
  name: string;
  route: string;
  baseUrl: string | null;
  apiKey: string;
  options: Record<string, unknown>;
  catalogId: string | null;
  catalogAt: string | null;
  /** The catalogue declared no address, so someone has to give one. */
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
}
```

`pick`, `pickLocal`, `pickCompatible` ed `edit` costruiscono tutte lo stesso
`Draft`, differendo solo nei valori di `needsUrl` e `needsKey`. In
`providers.html` le cinque condizioni su `form.kind` diventano due su quei due
campi, e il blocco che elenca i modelli — «Trova modelli», la select, la lista
— **esce dal modulo** e passa alla scheda del provider collegato, dove già
esiste per i provider salvati.

- [ ] **Step 4: Lanciali e guardali passare**

Da `app/`: `npx ng test`. Attesa: PASS, e nessun `form.kind` resta nel
template:

```bash
grep -c "form.kind" app/renderer/src/app/settings/providers.html
```

Attesa: `0`.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/settings/providers.ts app/renderer/src/app/settings/providers.html app/renderer/src/app/settings/providers.spec.ts
git commit -m "feat(providers): collegare non sceglie piu' un modello, e i quattro modi spariscono con esso"
```

---

### Task 4: La modale «Connetti provider»

**Files:**
- Modify: `app/renderer/src/app/settings/providers.html`, `providers.ts`
- Modify: `app/renderer/src/app/settings/providers.spec.ts`
- Modify: `app/locales/en.json`, `app/locales/it.json`

**Interfaces:**
- Consumes: `POPULAR` (Task 1), `envVar` (Task 2), `local.runtimes`, `catalog.search`
- Produces: nessuna interfaccia

- [ ] **Step 1: Scrivi il test che fallisce**

```typescript
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
```

`entry` in cima al file va completato con `envVar: "ACME_API_KEY"`.

- [ ] **Step 2: Lanciali e guardali fallire**

Da `app/`: `npx ng test`. Attesa: FAIL — nessun `open-connect`.

- [ ] **Step 3: Costruisci la modale**

In `providers.html`, al posto del blocco di ricerca in pagina, un pulsante che
apre la modale e la modale stessa:

```html
<dialog class="modal" [open]="connecting()" data-testid="connect-modal">
  <div class="modal-box max-w-xl">
    <h3 class="text-lg font-semibold">{{ t('providers.connectTitle') }}</h3>

    <input class="input w-full my-3" type="search" data-testid="catalog-query"
           [ngModel]="query()" [ngModelOptions]="{ standalone: true }"
           (ngModelChange)="search($event)" />

    <ul class="menu w-full">
      @if (runtimes().length > 0) {
        <li class="menu-title">{{ t('providers.localTitle') }}</li>
        @for (runtime of runtimes(); track runtime.id) {
          <li><a [attr.data-testid]="'entry-' + runtime.id" (click)="pickLocal(runtime)">
            <span class="grow">{{ runtime.name }}</span>
            <span class="badge badge-sm">{{ t('providers.local') }}</span>
          </a></li>
        }
      }

      <li class="menu-title">{{ t('providers.popularTitle') }}</li>
      @for (entry of popular(); track entry.id) {
        <li><a [attr.data-testid]="'entry-' + entry.id" (click)="pick(entry)">
          <span class="grow">{{ entry.name }}</span>
          <small class="opacity-60">{{ t('popular.' + entry.id) }}</small>
        </a></li>
      }

      <li class="menu-title">{{ t('providers.otherTitle') }}</li>
      <li><a data-testid="entry-custom" (click)="pickCompatible()">
        <span class="grow">{{ t('providers.compatible') }}</span>
        <span class="badge badge-sm">{{ t('providers.customBadge') }}</span>
      </a></li>
      @for (entry of others(); track entry.id) {
        <li><a [attr.data-testid]="'entry-' + entry.id"
               [class.menu-disabled]="entry.route === null"
               (click)="pick(entry)">
          <span class="grow">{{ entry.name }}</span>
          <small class="opacity-60">
            {{ t('providers.entryFacts', { models: entry.models }) }}{{ entry.envVar ? ' · ' + entry.envVar : '' }}
          </small>
        </a></li>
      }
    </ul>
  </div>
</dialog>
```

In `providers.ts`, `popular()` e `others()` partizionano i risultati della
ricerca: `popular()` sono le voci il cui id è in `POPULAR`, nell'ordine di
`POPULAR`; `others()` tutte le altre, in ordine alfabetico. A ricerca vuota,
`popular()` mostra i dieci e `others()` è vuota.

Le stringhe nuove: `providers.connectTitle`, `providers.popularTitle`,
`providers.otherTitle`, `providers.customBadge`, `providers.entryFacts` =
«{{models}} modelli» / «{{models}} models».

- [ ] **Step 4: Lanciali e guardali passare**

Da `app/`: `npx ng test`. Attesa: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/settings app/locales
git commit -m "feat(providers): una modale con tre gruppi, e il personalizzato fra gli altri"
```

---

### Task 5: «Provider connessi», e il verbo giusto

**Files:**
- Modify: `app/renderer/src/app/settings/providers.html`, `providers.ts`
- Modify: `app/renderer/src/app/settings/providers.spec.ts`
- Modify: `app/main/ipc.ts` (`confirmQuestion`, kind `deleteProvider`)
- Modify: `app/locales/en.json`, `app/locales/it.json`
- Modify: `app/test/confirm.test.ts`

**Interfaces:**
- Consumes: `providers.list`, `provider.delete`, `provider.verify`
- Produces: nessuna interfaccia

- [ ] **Step 1: Scrivi i test che falliscono**

In `providers.spec.ts`:

```typescript
it("says of a connected provider how it is authenticated", async () => {
  const { fixture } = mount(bridge({ "providers.list": [{ ...saved, hasKey: true }] }));
  await fixture.whenStable();
  fixture.detectChanges();

  expect(fixture.nativeElement.querySelector("[data-testid=auth-p1]").textContent)
    .toContain(catalog.providers["authKey"]);
});
```

In `confirm.test.ts`:

```typescript
it("disconnects a provider rather than deleting it, and says what goes with it", async () => {
  const { deps, questions } = await scene(true);

  await buildHandlers(deps)["ui.confirm"]({ kind: "deleteProvider", detail: { name: "OpenRouter" } });

  // The act is undoing a connection, not destroying a thing that was made
  // here: the verb has to match, or the question describes something else.
  expect(questions[0]!.verify).toBe("Disconnetti");
  expect(questions[0]!.message).toContain("OpenRouter");
});
```

- [ ] **Step 2: Lanciali e guardali fallire**

```bash
npx vitest run app/test/confirm.test.ts
```

Attesa: FAIL, `expected 'Elimina' to be 'Disconnetti'`.

- [ ] **Step 3: Riscrivi la sezione e il verbo**

In `app/main/ipc.ts`, `confirmQuestion` sceglie il verbo per il provider:

```typescript
  const base = {
    cancel: t("confirm.cancel"),
    verify: t(
      kind === "abandonProject" ? "confirm.abandon"
      : kind === "deleteProvider" ? "confirm.disconnect"
      : "confirm.delete",
    ),
  };
```

Le stringhe, in `it.json`:

```json
    "disconnect": "Disconnetti",
```
```json
    "deleteProvider": {
      "message": "Disconnettere «{{name}}»? Anche la sua chiave cifrata verrà rimossa."
    },
```

e in `en.json`: `"disconnect": "Disconnect"`, `"Disconnect “{{name}}”? Its
encrypted key will be removed too."`

In `providers.html`, la lista dei provider collegati diventa una sezione col
suo titolo, e ogni riga una `card` con l'etichetta di autenticazione — *Chiave
API*, *Nessuna chiave*, *Locale* — il modello in uso, e le azioni Verifica,
Modifica, **Disconnetti** (`btn btn-sm btn-error`).

Quando `providers()` è vuoto la sezione non c'è: niente titolo con sotto una
frase triste.

Stringhe nuove: `providers.connectedTitle`, `providers.authKey`,
`providers.authNone`, `providers.authLocal`, `providers.disconnect`.

- [ ] **Step 4: Lanciali e guardali passare**

```bash
npx vitest run app/test/confirm.test.ts app/test/locales.test.ts && cd app && npx ng test
```

Attesa: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/main/ipc.ts app/renderer/src/app/settings app/locales app/test/confirm.test.ts
git commit -m "feat(providers): i connessi in cima, e si disconnettono invece di essere eliminati"
```

---

### Task 6: La chiave trovata nell'ambiente

Un regalo quando c'è, mai un meccanismo.

**Files:**
- Modify: `app/shared/channels.ts`
- Modify: `app/main/ipc.ts`
- Modify: `app/renderer/src/app/settings/providers.html`, `providers.ts`
- Modify: `app/test/ipc.test.ts`
- Modify: `app/locales/en.json`, `app/locales/it.json`

**Interfaces:**
- Consumes: `CatalogEntry.envVar` (Task 2)
- Produces: canale `env.hasKey`: `{ req: { name: string }; res: boolean }`

- [ ] **Step 1: Scrivi il test che fallisce**

In `app/test/ipc.test.ts`:

```typescript
it("says whether a named variable holds something, never what it holds", async () => {
  process.env["BABELBOOK_TEST_KEY"] = "sk-secret";
  const handlers = buildHandlers(deps);

  const present = await handlers["env.hasKey"]({ name: "BABELBOOK_TEST_KEY" });
  const absent = await handlers["env.hasKey"]({ name: "BABELBOOK_TEST_MISSING" });

  // A boolean, and only a boolean: a key that crossed to the window to be
  // shown would be a key the window could leak.
  expect(present).toBe(true);
  expect(absent).toBe(false);
  delete process.env["BABELBOOK_TEST_KEY"];
});
```

- [ ] **Step 2: Lancialo e guardalo fallire**

```bash
npx vitest run app/test/ipc.test.ts
```

Attesa: FAIL — nessun handler `env.hasKey`.

- [ ] **Step 3: Aggiungi il canale e l'offerta**

In `app/shared/channels.ts`, fra le invocazioni, e nell'elenco `INVOCATIONS`:

```typescript
  /**
   * Whether a named environment variable holds anything. A boolean and never
   * the value: a key shown in the window is a key the window can leak.
   */
  "env.hasKey": { req: { name: string }; res: boolean };
```

In `app/main/ipc.ts`:

```typescript
    "env.hasKey": async ({ name }) => (process.env[name] ?? "") !== "",
```

Nel modulo di collegamento, quando `envVar` non è nullo e il canale risponde
`true`, sotto il campo della chiave compare una riga:

```html
@if (foundInEnv()) {
  <label class="label cursor-default gap-2">
    <input class="checkbox checkbox-sm" type="checkbox" data-testid="use-env-key"
           [ngModel]="useEnvKey()" [ngModelOptions]="{ standalone: true }"
           (ngModelChange)="useEnvKey.set($event)" />
    <span>{{ t('providers.foundInEnv', { name: draft()!.envVar }) }}</span>
  </label>
}
```

La stringa, in italiano: «Ho trovato una chiave in `{{name}}`. La uso?».

**Ciò che l'interfaccia non dice mai:** che una variabile *manchi*. Un'app
avviata dal menu applicazioni non eredita l'ambiente della shell, quindi
l'assenza non significa niente sull'utente e la frase suonerebbe come un
rimprovero per qualcosa che ha fatto giusto.

- [ ] **Step 4: Lancialo e guardalo passare**

```bash
npx vitest run app/test/ipc.test.ts app/test/locales.test.ts && cd app && npx ng test
```

Attesa: PASS. `ipc.test.ts` verifica anche che le chiavi degli handler siano
esattamente i canali dichiarati: se fallisce, `env.hasKey` manca da
`INVOCATIONS`.

- [ ] **Step 5: Commit**

```bash
git add app/shared/channels.ts app/main/ipc.ts app/renderer/src/app/settings app/locales app/test/ipc.test.ts
git commit -m "feat(providers): se la chiave e' gia' nell'ambiente, l'applicazione lo dice e la offre"
```

---

### Task 7: Tutto insieme, e le schermate

**Files:**
- Modify: `app/e2e/providers.spec.ts`
- Modify: `app/e2e/screenshots/*`

**Interfaces:**
- Consumes: tutti i task precedenti
- Produces: niente

- [ ] **Step 1: Aggiorna il cammino end-to-end**

`app/e2e/providers.spec.ts` percorre oggi «cerca, scegli, incolla». Il cammino
diventa: apri la modale (`open-connect`), cerca, scegli, incolla la chiave,
chiudi — e **poi**, sulla scheda del provider collegato, scegli il modello. È
il piano intero espresso come gesto, e se questo test non si lascia riscrivere
in modo naturale, la separazione dei due atti non è riuscita.

Aggiungi una schermata nuova, `settings-providers-connect`, in chiaro e scuro:
la modale aperta è la parte del lavoro che nessuna delle ventidue esistenti
mostra.

- [ ] **Step 2: La suite intera**

Dalla radice:

```bash
npm run typecheck && npm test -w core && npm test -w app
```

Da `app/`:

```bash
xvfb-run --auto-servernum npm run test:e2e
```

Attesa: tutto verde.

- [ ] **Step 3: Guarda le schermate**

Apri `settings-providers-light/dark` e le due nuove della modale. Quattro cose
da cercare:

1. **I connessi stanno sopra** e si distinguono dai disponibili.
2. **I motori locali precedono i popolari** nella modale.
3. **Le voci della coda portano la loro riga** — modelli e variabile — e non un
   nome nudo.
4. **Il personalizzato è dentro la lista**, non un pulsante a fianco.

- [ ] **Step 4: Commit**

```bash
git add app/e2e
git commit -m "test(e2e): collegare e scegliere come due gesti, e la modale guardata"
```
