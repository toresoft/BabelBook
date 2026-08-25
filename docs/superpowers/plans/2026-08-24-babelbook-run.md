# babelBook — Piano 4: esecuzione, provider e composizione

**Stato: completo, task 9 su 9**, al 2026-08-25 — provider e chiavi cifrate,
risoluzione del modello, verifica, macchina a stati, engine nell'`utilityProcess`,
orchestratore persistente, composizione con gate, ciclo di vita con tray e
notifiche, e la prova end-to-end con backend finto: un libro intero tradotto,
messo in pausa, riavviato e ripreso senza ritradurre.

Resta fuori dalla suite, com'è giusto che sia: la traduzione di un libro vero
con un provider vero (in fondo al piano).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** far tradurre un libro davvero — provider configurabili con chiavi cifrate, motore in un processo dedicato, macchina a stati che decide cosa è lecito, pausa e ripresa, EPUB finale con il suo gate.

**Architecture:** il main orchestra e possiede il database; l'engine gira in un `utilityProcess` e non tocca il database, ma passa da un proxy IPC di `ProjectStore`; la macchina XState dice cosa è lecito e non esegue nulla. Chiudere la finestra non ferma il lavoro: l'applicazione resta viva in tray.

**Tech Stack:** Electron 43, XState 5, Vercel AI SDK (`ai` più i pacchetti `@ai-sdk/*` che l'utente installa), `safeStorage`.

**Spec:** `docs/superpowers/specs/2026-08-24-babelbook-design.md`
**Piani precedenti:** 1 (EPUB), 2 (traduzione), 3 (shell e database) — tutti obbligatori.

## Revisione dell'ambito rispetto al piano 3

Il piano 3 collocava la configurazione dei provider nel piano 5. Sta qui: senza chiavi e senza risoluzione del modello, l'engine di questo piano non ha nulla da chiamare, e un piano che non si può eseguire non si può nemmeno verificare. Al piano 5 restano le schermate dei due gate, i glossari, la scheda delle unità e il report.

## Global Constraints

- **Node 24.18.x**: `export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`
- **`core/` resta puro.** I pacchetti dei provider si importano solo in `app/engine/backends/`, dinamicamente. Il test di confine dei piani 1 e 2 continua a girare.
- **Nessun test tocca la rete.** L'unica prova con un provider vero è manuale ed è in fondo al piano.
- **Nessuno spende senza che l'utente l'abbia chiesto.** Un progetto trovato in `running` all'avvio torna a `paused`.
- **Le chiavi non arrivano mai al renderer**, nemmeno mascherate. Il renderer vede "impostata" o "mancante".
- **Codice e commenti in inglese**, documenti in italiano, interfaccia dai cataloghi.
- **Commit a ogni task.**

## Struttura dei file

```
app/
  main/
    providers/store.ts        CRUD dei provider, cifratura con safeStorage
    providers/verify.ts       la chiamata minima di prova
    run/orchestrator.ts       le fasi, i gate, gli eventi
    run/machine-host.ts       attore XState, snapshot su database
    run/engine-host.ts        avvio e vita dell'utilityProcess
    run/store-proxy.ts        il lato main del proxy ProjectStore
    tray.ts                   icona, menu, notifiche
    compose.ts                fase 9: dallo scheletro all'EPUB
  engine/
    main.ts                   entry point dell'utilityProcess
    backends/resolve.ts       specifica del modello -> LanguageModel
    backends/sdk.ts           LlmBackend sopra l'AI SDK
    store-client.ts           il lato engine del proxy ProjectStore
core/
  workflow/project.machine.ts la macchina, dominio puro
```

---

### Task 1: Provider e chiavi

**Files:**
- Create: `app/main/providers/store.ts`, `app/test/providers.test.ts`

**Interfaces:**

```ts
export interface ProviderModel {
  id: string; displayName: string;
  contextWindow: number | null;
  priceIn: number | null; priceOut: number | null;   // per milione di token
}
export interface Provider {
  id: string; name: string;
  route: string;                    // il pacchetto @ai-sdk/* che lo serve
  baseUrl: string | null;
  headers: Record<string, string>;
  options: Record<string, unknown>; // opzioni di chiamata che la rotta richiede
  models: ProviderModel[];
  hasKey: boolean;                  // l'unica cosa che il renderer sa della chiave
}
export interface Crypto {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}
export function createProvider(db: DatabaseSync, crypto: Crypto, input: Omit<Provider, "id" | "hasKey"> & { apiKey?: string }): Provider;
export function updateProvider(db: DatabaseSync, crypto: Crypto, id: string, patch: Partial<Provider> & { apiKey?: string }): Provider;
export function listProviders(db: DatabaseSync): Provider[];
export function readKey(db: DatabaseSync, crypto: Crypto, id: string): string | null;
export const PRESETS: Array<Omit<Provider, "id" | "hasKey">>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/providers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { createProvider, listProviders, PRESETS, readKey, updateProvider } from "../main/providers/store.ts";

const crypto = {
  isAvailable: () => true,
  encrypt: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
  decrypt: (blob: Buffer) => blob.toString("utf8").replace(/^enc:/, ""),
};

function db() {
  const d = openDatabase(":memory:");
  migrate(d, loadMigrations("app/main/db/migrations"));
  return d;
}

const acme = {
  name: "Acme", route: "acme", baseUrl: "https://api.acme.test/v1",
  headers: {}, options: {},
  models: [{ id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5 }],
};

describe("providers", () => {
  it("never stores the key in the clear", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    const row = d.prepare("SELECT api_key_encrypted FROM provider WHERE id = ?").get(p.id) as { api_key_encrypted: Buffer };
    expect(row.api_key_encrypted.toString("utf8")).not.toContain("sk-secret");
    expect(readKey(d, crypto, p.id)).toBe("sk-secret");
  });

  it("tells the renderer whether a key is there, and nothing more", () => {
    const d = db();
    createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    const listed = listProviders(d);
    expect(listed[0].hasKey).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("sk-secret");
  });

  it("keeps the existing key when an update does not carry one", () => {
    const d = db();
    const p = createProvider(d, crypto, { ...acme, apiKey: "sk-secret" });
    updateProvider(d, crypto, p.id, { name: "Acme Inc" });
    expect(readKey(d, crypto, p.id)).toBe("sk-secret");
  });

  it("refuses to store a key when the OS keyring is unavailable", () => {
    const d = db();
    const unavailable = { ...crypto, isAvailable: () => false };
    expect(() => createProvider(d, unavailable, { ...acme, apiKey: "sk-secret" }))
      .toThrow(/KEYRING_UNAVAILABLE/);
  });

  it("ships a preset that reaches any OpenAI-compatible endpoint", () => {
    expect(PRESETS.map((p) => p.name)).toContain("OpenAI-compatible");
    const deepseek = PRESETS.find((p) => p.route === "deepseek")!;
    expect(deepseek.options).toMatchObject({ deepseek: { thinking: { type: "disabled" } } });
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/providers.test.ts`
Atteso: FAIL, `Cannot find module '../main/providers/store.ts'`.

- [ ] **Step 3: Implementare**

`Crypto` è un'interfaccia perché i test non possono usare `safeStorage`: in produzione la implementa `safeStorage` di Electron, nei test la finge. Se il portachiavi non è disponibile si **rifiuta di salvare** invece di scrivere in chiaro: una chiave in chiaro dentro un database che l'utente copia altrove è un incidente che non si vede finché non è successo.

I preset caricano valori iniziali per Anthropic, OpenAI, DeepSeek, Mistral e un **OpenAI-compatible** generico con `baseUrl` da riempire. Le `options` del preset sono correzioni necessarie, non preferenze: DeepSeek V4 ragiona di default e brucia l'intero budget di output in token di ragionamento, il gruppo torna vuoto con `finishReason: "length"` e ogni unità cade sul sorgente a prezzo pieno.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/providers.test.ts`
Atteso: PASS, cinque test.

- [ ] **Step 5: Commit**

```bash
git add app/main/providers app/test/providers.test.ts
git commit -m "feat(providers): encrypted keys, presets that carry the fixes they need"
```

---

### Task 2: Dalla specifica del modello a un backend

**Files:**
- Create: `app/engine/backends/resolve.ts`, `app/engine/backends/sdk.ts`, `app/test/resolve.test.ts`

**Interfaces:**

```ts
export class ModelSpecError extends Error { spec: string; code: string }
export interface ResolvedModel { model: unknown; modelId: string; options?: Record<string, unknown> }
export type ModuleLoader = (specifier: string) => Promise<unknown>;
export function parseSpec(spec: string): { route: string; id: string };
export function resolveModel(spec: string, deps: {
  load: ModuleLoader; apiKey: string | null; baseUrl: string | null;
  headers?: Record<string, string>; options?: Record<string, unknown>;
}): Promise<ResolvedModel>;
export function sdkBackend(resolved: ResolvedModel, generate: GenerateFn): LlmBackend;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/resolve.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { parseSpec, resolveModel, sdkBackend } from "../engine/backends/resolve.ts";

const fakeModule = { createAcme: (opts: unknown) => (id: string) => ({ id, opts }) };
const load = async (specifier: string) => {
  if (specifier === "@ai-sdk/acme") return fakeModule;
  throw new Error(`Cannot find package '${specifier}'`);
};

describe("parseSpec", () => {
  it("cuts at the first colon, because model ids carry their own", () => {
    expect(parseSpec("bedrock:arn:aws:foo:0")).toEqual({ route: "bedrock", id: "arn:aws:foo:0" });
  });

  it("refuses a spec with no route", () => {
    expect(() => parseSpec("claude-opus")).toThrow(/MISSING_ROUTE/);
  });

  it("refuses a route that could not be a package name", () => {
    expect(() => parseSpec("../evil:m1")).toThrow(/INVALID_ROUTE/);
  });
});

describe("resolveModel", () => {
  it("fails before anything is opened when the package is absent", async () => {
    await expect(resolveModel("ghost:m1", { load, apiKey: "k", baseUrl: null }))
      .rejects.toMatchObject({ code: "PACKAGE_MISSING" });
  });

  it("fails when the key is missing, naming the provider", async () => {
    await expect(resolveModel("acme:m1", { load, apiKey: null, baseUrl: null }))
      .rejects.toMatchObject({ code: "MISSING_KEY" });
  });

  it("carries the provider options into the resolved model", async () => {
    const resolved = await resolveModel("acme:m1", {
      load, apiKey: "k", baseUrl: null, options: { acme: { thinking: { type: "disabled" } } },
    });
    expect(resolved.modelId).toBe("acme:m1");
    expect(resolved.options).toMatchObject({ acme: { thinking: { type: "disabled" } } });
  });
});

describe("sdkBackend", () => {
  it("passes the options through and reports the finish reason", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: "Uno", usage: { inputTokens: 10, outputTokens: 3 }, finishReason: "stop",
    });
    const backend = sdkBackend({ model: {}, modelId: "acme:m1", options: { acme: {} } }, generate);
    const result = await backend.call({ prompt: "One" });
    expect(result).toMatchObject({ text: "Uno", tokensIn: 10, tokensOut: 3, finishReason: "stop" });
    expect(generate.mock.calls[0][0].providerOptions).toEqual({ acme: {} });
  });

  it("reports truncation as such, so the engine can split the chunk", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: "Un", usage: { inputTokens: 10, outputTokens: 4096 }, finishReason: "length",
    });
    const backend = sdkBackend({ model: {}, modelId: "acme:m1" }, generate);
    expect((await backend.call({ prompt: "One" })).finishReason).toBe("length");
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/resolve.test.ts`
Atteso: FAIL, `Cannot find module '../engine/backends/resolve.ts'`.

- [ ] **Step 3: Implementare**

1. La sintassi è `route:id`. Si taglia al **primo** due punti, mai all'ultimo: gli id dei modelli ne portano di propri — un ARN di Bedrock finisce con `:0` — e tagliare in fondo dimezza l'id.
2. La rotta diventa parte di un nome di pacchetto, quindi si valida per prima con `/^[a-z0-9][a-z0-9-]*$/`: senza, una rotta scelta male è un import arbitrario.
3. `load` è iniettabile per la stessa ragione per cui `Crypto` lo è: i test non installano pacchetti.
4. **La risoluzione avviene prima che l'EPUB venga aperto.** Pacchetto mancante, chiave assente, specifica malformata devono emergere alla partenza, non al primo gruppo, quando l'analisi ha già speso.
5. `sdkBackend` avvolge `generateText` dell'AI SDK e traduce il risultato nella forma di `LlmBackend` del piano 2. `finishReason: "length"` va riportato fedelmente: è il solo segnale che autorizza il motore a spezzare un gruppo.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/resolve.test.ts`
Atteso: PASS, otto test.

- [ ] **Step 5: Commit**

```bash
git add app/engine/backends app/test/resolve.test.ts
git commit -m "feat(engine): resolve the model before opening the book"
```

---

### Task 3: Verifica di un provider

**Files:**
- Create: `app/main/providers/verify.ts`, `app/test/verify.test.ts`
- Modify: `app/shared/channels.ts`, `app/main/ipc.ts`

**Interfaces:**

```ts
export interface VerifyResult {
  ok: boolean;
  code?: "missing-key" | "package-missing" | "unauthorized" | "unreachable" | "bad-spec" | "unknown";
  latencyMs?: number;
  modelId?: string;
}
export function verifyProvider(deps: { backend: LlmBackend; modelId: string }): Promise<VerifyResult>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/verify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { verifyProvider } from "../main/providers/verify.ts";

const ok = { call: async () => ({ text: "pong", tokensIn: 1, tokensOut: 1, finishReason: "stop" as const }) };
const failing = (message: string) => ({ call: async () => { throw new Error(message); } });

describe("verifyProvider", () => {
  it("reports success with the round trip time", async () => {
    const result = await verifyProvider({ backend: ok, modelId: "acme:m1" });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps an authentication failure to a code, not a raw message", async () => {
    const result = await verifyProvider({ backend: failing("401 Unauthorized"), modelId: "acme:m1" });
    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("maps a network failure to unreachable", async () => {
    const result = await verifyProvider({ backend: failing("getaddrinfo ENOTFOUND api.acme.test"), modelId: "acme:m1" });
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
  });

  it("does not leak the provider message to the caller", async () => {
    const result = await verifyProvider({ backend: failing("401 Unauthorized key sk-abc123"), modelId: "acme:m1" });
    expect(JSON.stringify(result)).not.toContain("sk-abc123");
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/verify.test.ts`
Atteso: FAIL, `Cannot find module '../main/providers/verify.ts'`.

- [ ] **Step 3: Implementare**

La verifica manda il prompt più corto che abbia senso e misura il tempo. Gli errori si **classificano in codici**, che l'interfaccia traduce dal catalogo: il messaggio grezzo del provider è in inglese, cambia senza preavviso e a volte contiene la chiave. Quest'ultimo punto è il motivo per cui il messaggio non viene mai propagato, nemmeno nei log.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/verify.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add app/main/providers/verify.ts app/test/verify.test.ts app/shared/channels.ts app/main/ipc.ts
git commit -m "feat(providers): verify with codes, never with the provider's own words"
```

---

### Task 4: La macchina a stati

**Files:**
- Create: `core/workflow/project.machine.ts`, `core/test/machine.test.ts`
- Modify: `core/package.json` (dipendenza `xstate`)

**Interfaces:**

```ts
export type ProjectState =
  | "new" | "needs-language" | "ready" | "running"
  | "waiting-terms" | "waiting-code" | "composing"
  | "paused" | "done" | "incomplete" | "failed";

export interface ProjectContext {
  hasApprovedTerms: boolean;
  hasReviewedExclusions: boolean;
  sourceHashMatches: boolean;
  degradations: number;
  autoAcceptTerms: boolean;
  autoAcceptExclusions: boolean;
}

export type ProjectEvent =
  | { type: "LANGUAGE_SET" } | { type: "START" }
  | { type: "TERMS_READY" } | { type: "TERMS_APPROVED" }
  | { type: "CODE_INDEXED" } | { type: "CODE_REVIEWED" }
  | { type: "TRANSLATED" } | { type: "COMPOSED" }
  | { type: "PAUSE" } | { type: "RESUME" }
  | { type: "FAIL"; reason: string };

export const projectMachine: StateMachine</* … */>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/machine.test.ts`:

```ts
import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { projectMachine } from "../workflow/project.machine.ts";

const start = (context: Partial<ProjectContext> = {}, state = "ready") =>
  createActor(projectMachine.provide({}), {
    input: {
      hasApprovedTerms: false, hasReviewedExclusions: false, sourceHashMatches: true,
      degradations: 0, autoAcceptTerms: false, autoAcceptExclusions: false, ...context,
    },
    snapshot: projectMachine.resolveState({ value: state, context: {} as never }),
  }).start();

describe("projectMachine", () => {
  it("stops at the terms gate", () => {
    const actor = start();
    actor.send({ type: "START" });
    actor.send({ type: "TERMS_READY" });
    expect(actor.getSnapshot().value).toBe("waiting-terms");
  });

  it("walks through the terms gate when auto-acceptance is on", () => {
    const actor = start({ autoAcceptTerms: true });
    actor.send({ type: "START" });
    actor.send({ type: "TERMS_READY" });
    expect(actor.getSnapshot().value).toBe("running");
  });

  it("refuses to resume a project whose terms are still pending", () => {
    const actor = start();
    actor.send({ type: "START" });
    actor.send({ type: "TERMS_READY" });
    actor.send({ type: "RESUME" });
    expect(actor.getSnapshot().value).toBe("waiting-terms");
  });

  it("refuses to start when the source no longer matches its hash", () => {
    const actor = start({ sourceHashMatches: false });
    actor.send({ type: "START" });
    expect(actor.getSnapshot().value).toBe("ready");
  });

  it("ends incomplete when the run declared degradations", () => {
    const actor = start({ degradations: 3, hasApprovedTerms: true, hasReviewedExclusions: true }, "composing");
    actor.send({ type: "COMPOSED" });
    expect(actor.getSnapshot().value).toBe("incomplete");
  });

  it("survives a round trip through a persisted snapshot", () => {
    const actor = start();
    actor.send({ type: "START" });
    const persisted = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()));
    const revived = createActor(projectMachine, { snapshot: persisted }).start();
    expect(revived.getSnapshot().value).toBe(actor.getSnapshot().value);
  });

  it("tells the interface which transitions are available", () => {
    const actor = start();
    expect(actor.getSnapshot().can({ type: "START" })).toBe(true);
    expect(actor.getSnapshot().can({ type: "RESUME" })).toBe(false);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/machine.test.ts`
Atteso: FAIL, `Cannot find module '../workflow/project.machine.ts'`.

- [ ] **Step 3: Implementare**

La macchina è **dichiarativa e non esegue niente**: nessun `invoke`, nessun attore figlio, nessuna chiamata. Come il componente Workflow di Symfony, dice cosa è lecito; l'orchestratore del Task 6 esegue la fase e poi le manda l'evento.

Le guard leggono il contesto: `hasApprovedTerms`, `hasReviewedExclusions`, `sourceHashMatches`, `autoAcceptTerms`, `autoAcceptExclusions`, `degradations`. Con l'auto-accettazione attiva, il gate corrispondente è una transizione immediata invece di una sosta.

**Se la macchina vivesse dentro `app/`, la logica di stato finirebbe mescolata all'IPC.** Sta in `core/workflow/` perché è dominio: non importa Electron, e i suoi test girano con il resto del core.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/machine.test.ts`
Atteso: PASS, sette test.

- [ ] **Step 5: Commit**

```bash
git add core/workflow core/test/machine.test.ts core/package.json
git commit -m "feat(workflow): a machine that says what is allowed and runs nothing"
```

---

### Task 5: Il processo dell'engine e il proxy dello store

**Files:**
- Create: `app/engine/main.ts`, `app/engine/store-client.ts`, `app/main/run/store-proxy.ts`, `app/main/run/engine-host.ts`, `app/test/engine-host.test.ts`
- Modify: `app/esbuild.mjs` (terzo bundle)

**Interfaces:**

```ts
// dal main verso l'engine
export type EngineCommand =
  | { type: "start"; projectId: string; config: RunConfig }
  | { type: "pause" } | { type: "cancel" };
// dall'engine verso il main
export type EngineMessage =
  | { type: "phase"; phase: string }
  | { type: "progress"; done: number; total: number }
  | { type: "gate"; gate: "terms" | "code" }
  | { type: "done"; summary: RunSummary }
  | { type: "failed"; code: string }
  | { type: "store"; id: number; method: string; args: unknown[] };

export function startEngine(): EngineHandle;
export interface EngineHandle {
  send(command: EngineCommand): void;
  on(listener: (m: EngineMessage) => void): () => void;
  kill(): Promise<void>;
  alive: boolean;
}
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/engine-host.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeStoreProxy } from "../main/run/store-proxy.ts";
import { FakeStore } from "../../core/test/fake/store.ts";

describe("store proxy", () => {
  it("answers a method call over the message channel", async () => {
    const store = new FakeStore();
    await store.putTranslation({ unitId: "u1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated" });
    const send = vi.fn();
    const proxy = makeStoreProxy(store, send);
    await proxy.handle({ type: "store", id: 7, method: "translations", args: ["k1"] });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 7, ok: true }));
  });

  it("refuses a method that is not part of the ProjectStore contract", async () => {
    const send = vi.fn();
    const proxy = makeStoreProxy(new FakeStore(), send);
    await proxy.handle({ type: "store", id: 1, method: "constructor", args: [] });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 1, ok: false, code: "UNKNOWN_METHOD" }));
  });

  it("returns the error as a code, not as an exception that crosses the boundary", async () => {
    const broken = { ...new FakeStore(), units: async () => { throw new Error("disk on fire"); } };
    const send = vi.fn();
    const proxy = makeStoreProxy(broken as never, send);
    await proxy.handle({ type: "store", id: 2, method: "units", args: [] });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 2, ok: false }));
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/engine-host.test.ts`
Atteso: FAIL, `Cannot find module '../main/run/store-proxy.ts'`.

- [ ] **Step 3: Implementare**

L'engine gira in un `utilityProcess` con un `MessagePort` dedicato. **Non tocca il database**: `store-client.ts` implementa `ProjectStore` inoltrando ogni chiamata al main, che la esegue con `SqliteProjectStore`. Il database resta di un processo solo, quindi non servono lock né una seconda connessione WAL.

Il proxy accetta **solo i metodi del contratto** — un elenco esplicito, non `store[method]` — perché altrimenti un messaggio malformato invoca qualunque proprietà dell'oggetto.

Un crash dell'engine non porta giù la finestra: `engine-host` lo osserva, segna il progetto `paused` e registra un evento. Le unità già confermate restano, quindi riprendere costa solo ciò che mancava.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/engine-host.test.ts`
Atteso: PASS, tre test.

- [ ] **Step 5: Commit**

```bash
git add app/engine app/main/run app/esbuild.mjs app/test/engine-host.test.ts
git commit -m "feat(run): the engine works through a proxy, the database stays in one process"
```

---

### Task 6: L'orchestratore

**Files:**
- Create: `app/main/run/orchestrator.ts`, `app/main/run/machine-host.ts`, `app/test/orchestrator.test.ts`

**Interfaces:**

```ts
export interface RunConfig {
  projectId: string; cacheKey: string;
  sourceLanguage: string; targetLanguage: string;
  autoAcceptTerms: boolean; autoAcceptExclusions: boolean;
  concurrency: number;
}
export function runProject(deps: {
  db: DatabaseSync; store: ProjectStore; backend: LlmBackend;
  config: RunConfig; emit: (m: EngineMessage) => void; signal: AbortSignal;
}): Promise<RunSummary>;
export function restoreRunningProjects(db: DatabaseSync): string[];   // ids riportati a paused
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/orchestrator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { restoreRunningProjects, runProject } from "../main/run/orchestrator.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { FakeStore } from "../../core/test/fake/store.ts";
import { FakeBackend } from "../../core/test/fake/backend.ts";
import type { TranslationUnit } from "../../core/epub/index.ts";

const unit = (n: number): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n * 100, n * 100 + 20], source: `Sentence ${n}`, raw: `Sentence ${n}`, state: "translate",
});

/** Risponde a qualunque prompt nel formato che la fase richiede. */
const scriptedBackend = () => new FakeBackend((call) => {
  const text = call.prompt.includes("TERMS")
    ? "TERMS 0\nEND"
    : call.prompt.includes("VERDICTS")
      ? "VERDICTS 0\nEND"
      : call.prompt.includes("UNITS")
        ? `UNITS 1\n[u:c1.xhtml#1]\nFrase 1\nEND`
        : "en";
  return { text, tokensIn: 10, tokensOut: 5, finishReason: "stop" as const };
});

const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  projectId: "p1", cacheKey: "k1", sourceLanguage: "en", targetLanguage: "it",
  autoAcceptTerms: false, autoAcceptExclusions: false, concurrency: 1, ...over,
});

function collect() {
  const seen: string[] = [];
  return { seen, emit: (m: EngineMessage) => seen.push(m.type === "gate" ? `gate:${m.gate}` : m.type) };
}

describe("runProject", () => {
  it("stops at the terms gate and emits it, without translating anything", async () => {
    const store = new FakeStore([unit(1)]);
    const { seen, emit } = collect();
    await runProject({
      db: openDatabase(":memory:"), store, backend: scriptedBackend(),
      config: config(), emit, signal: new AbortController().signal,
    });
    expect(seen).toContain("gate:terms");
    expect((await store.translations("k1")).size).toBe(0);
  });

  it("goes through both gates when auto-acceptance is on for both", async () => {
    const store = new FakeStore([unit(1)]);
    const { seen, emit } = collect();
    await runProject({
      db: openDatabase(":memory:"), store, backend: scriptedBackend(),
      config: config({ autoAcceptTerms: true, autoAcceptExclusions: true }),
      emit, signal: new AbortController().signal,
    });
    expect(seen.filter((s) => s.startsWith("gate:"))).toEqual([]);
    expect((await store.translations("k1")).get("c1.xhtml#1")?.text).toBe("Frase 1");
  });

  it("does not ask the model again for a unit the cache already holds", async () => {
    const store = new FakeStore([unit(1)]);
    await store.putTranslation({
      unitId: "c1.xhtml#1", text: "Frase 1", cacheKey: "k1", attempts: 1, outcome: "translated",
    });
    const backend = scriptedBackend();
    await runProject({
      db: openDatabase(":memory:"), store, backend,
      config: config({ autoAcceptTerms: true, autoAcceptExclusions: true }),
      emit: collect().emit, signal: new AbortController().signal,
    });
    expect(backend.prompts.some((p) => p.includes("[u:c1.xhtml#1]"))).toBe(false);
  });

  it("raises the run to incomplete when a unit fell back", async () => {
    const store = new FakeStore([unit(1)]);
    const backend = new FakeBackend((call) =>
      call.prompt.includes("UNITS")
        ? { text: `UNITS 1\n[u:c1.xhtml#1]\n\nEND`, tokensIn: 1, tokensOut: 1, finishReason: "stop" as const }
        : { text: "TERMS 0\nEND", tokensIn: 1, tokensOut: 1, finishReason: "stop" as const });
    const summary = await runProject({
      db: openDatabase(":memory:"), store, backend,
      config: config({ autoAcceptTerms: true, autoAcceptExclusions: true }),
      emit: collect().emit, signal: new AbortController().signal,
    });
    expect(summary.units.fellBack).toBe(1);
    expect(store.events.map((e) => e.severity)).toContain("degradation");
  });
});

describe("restoreRunningProjects", () => {
  it("moves a project found running back to paused, and never resumes on its own", () => {
    const db = openDatabase(":memory:");
    migrate(db, loadMigrations("app/main/db/migrations"));
    db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
      + "VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','running')").run();
    expect(restoreRunningProjects(db)).toEqual(["p1"]);
    const row = db.prepare("SELECT state FROM project WHERE id='p1'").get() as { state: string };
    expect(row.state).toBe("paused");
  });
});
```


Run: `npx vitest run app/test/orchestrator.test.ts`
Atteso: FAIL, `Cannot find module '../main/run/orchestrator.ts'`.

- [ ] **Step 3: Implementare**

L'orchestratore esegue le fasi del piano 2 nell'ordine della spec, e dopo ognuna manda l'evento alla macchina:

1. analisi e candidati, poi `TERMS_READY`;
2. se la macchina si ferma in `waiting-terms`, emette `gate: "terms"` e **ritorna**: la ripresa arriverà dall'interfaccia con `TERMS_APPROVED`;
3. indice del codice, poi `CODE_INDEXED`, con la stessa logica per `waiting-code`;
4. traduzione, con `progress` a ogni unità confermata;
5. composizione (Task 7), poi `COMPOSED`.

Tre regole:

- **Una fase il cui risultato è già in database non si rifà.** La ripresa è idempotente perché ricalcola cosa manca, non perché ricorda dove era.
- **Lo snapshot della macchina si salva a ogni transizione accettata**, insieme alla colonna `state` denormalizzata.
- **Le degradazioni contano.** Se `run_event` contiene eventi con `severity: "degradation"`, la macchina va in `incomplete`, non in `done`.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/orchestrator.test.ts`
Atteso: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/main/run app/test/orchestrator.test.ts
git commit -m "feat(run): phases execute, the machine decides, degradations are counted"
```

---

### Task 7: Composizione dell'EPUB

**Files:**
- Create: `app/main/compose.ts`, `app/test/compose.test.ts`

**Interfaces:**

```ts
export interface ComposeResult {
  outputPath: string;
  invariants: InvariantResult[];
  epubcheck: EpubcheckResult;
  overlaysRemoved: { overlays: number; audio: number };
  status: "complete" | "incomplete" | "failed";
}
export function composeEpub(input: {
  workspace: Workspace; store: ProjectStore; cacheKey: string;
  targetLanguage: string; title: string;
}): Promise<ComposeResult>;
```

- [x] **Step 1: Scrivere i test che falliscono**

`app/test/compose.test.ts`:

```ts
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { extract, readEpub, sha256 } from "../../core/epub/index.ts";
import { FakeStore } from "../../core/test/fake/store.ts";
import { copySource, createWorkspace } from "../main/workspace.ts";
import { composeEpub } from "../main/compose.ts";

/** Un workspace con un libro copiato e uno store che ne conosce le unità. */
async function prepared(spec: Parameters<typeof buildEpub>[0]) {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-compose-"));
  const epubPath = join(dir, "book.epub");
  await writeFile(epubPath, await buildEpub(spec));
  const workspace = await createWorkspace(dir, "p1");
  await copySource(workspace, epubPath);

  const epub = await readEpub(await readFile(workspace.source));
  const doc = spec.documents[0].path;
  const source = epub.get(doc)!.toString("utf8");
  const { units } = extract({ source, doc });
  return { dir, workspace, units, store: new FakeStore(units) };
}

const prose = { documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two</p>" }], language: "en" };

describe("composeEpub", () => {
  it("writes to a new path and leaves the source untouched", async () => {
    const { workspace, store } = await prepared(prose);
    const before = sha256(await readFile(workspace.source));
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    expect(result.outputPath).not.toBe(workspace.source);
    expect(sha256(await readFile(workspace.source))).toBe(before);
  });

  it("changes only the language fields when no unit was translated", async () => {
    const { workspace, store } = await prepared(prose);
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    expect(result.invariants.filter((i) => !i.ok && !i.skipped)).toEqual([]);
    const out = await readEpub(await readFile(result.outputPath));
    expect(out.get("OEBPS/c1.xhtml")!.toString("utf8")).toContain("<p>One</p>");
  });

  it("removes the overlays and says how many", async () => {
    const { workspace, store } = await prepared({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">One</p>` }],
      overlays: [{ smilPath: "OEBPS/c1.smil", audioPath: "OEBPS/c1.mp3", forDocument: "OEBPS/c1.xhtml", duration: "0:00:05" }],
    });
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    expect(result.overlaysRemoved.overlays).toBe(1);
    const out = await readEpub(await readFile(result.outputPath));
    expect(out.order.some((p) => p.endsWith(".smil"))).toBe(false);
    expect(result.invariants.find((i) => i.id === "I22")?.ok).toBe(true);
  });

  it("keeps the rejected file when an invariant fails, so it can be inspected", async () => {
    const { workspace, store, units } = await prepared(prose);
    // una traduzione che butta via il markup: I17 deve scattare
    await store.putTranslation({
      unitId: units[0].id, text: "", cacheKey: "k1", attempts: 1, outcome: "translated",
    });
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    expect(result.status).toBe("failed");
    expect(existsSync(result.outputPath)).toBe(true);
  });

  it("says epubcheck did not run when the jar is absent, and never calls that a pass", async () => {
    const { workspace, store } = await prepared(prose);
    process.env.EPUBCHECK_JAR = "/nope/missing.jar";
    const result = await composeEpub({
      workspace, store, cacheKey: "k1", targetLanguage: "it", title: "Book",
    });
    delete process.env.EPUBCHECK_JAR;
    expect(result.epubcheck.ran).toBe(false);
    expect(result.status).not.toBe("failed");
  });
});
```

- [x] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/compose.test.ts`
Atteso: FAIL, `Cannot find module '../main/compose.ts'`.

- [x] **Step 3: Implementare**

Per ogni documento: si rileggono le unità dal database, si rende ognuna con `render` (piano 1), si costruisce lo scheletro e lo si riempie. Poi `writeRootLang` sui documenti, `writeLanguage` sull'OPF, `removeOverlays` se il libro ne ha, e `writeEpub`.

Infine il gate: `inspect` prima e dopo, `checkInvariants`, ed `runEpubcheck` se il jar c'è.

Tre regole:

- **L'output va sempre su un percorso nuovo.** Se il gate rifiuta il libro, il sorgente è intatto e il file rifiutato resta ispezionabile: cancellarlo toglie l'unico modo di capire cosa è andato storto.
- **Le unità senza traduzione riemettono `raw`.** È ciò che rende identico un libro non tradotto, e quindi rende il gate un'asserzione vera.
- **EPUBCheck assente non è EPUBCheck passato.** Il risultato lo dichiara, e l'interfaccia lo mostra come "non eseguito".

- [x] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/compose.test.ts`
Atteso: PASS, cinque test.

- [x] **Step 5: Commit**

```bash
git add app/main/compose.ts app/test/compose.test.ts
git commit -m "feat(compose): a new file every time, and a gate that can really fail"
```

---

### Task 8: Pausa, ripresa, tray

**Files:**
- Create: `app/main/tray.ts`, `app/test/lifecycle.test.ts`
- Modify: `app/main/main.ts`, `app/shared/channels.ts`, `app/main/ipc.ts`

**Interfaces:**

```ts
export interface Lifecycle {
  onWindowClose(hasRunningWork: boolean): "hide" | "quit";
  onQuitRequested(hasRunningWork: boolean): "confirm" | "quit";
}
export function trayTooltip(state: { title: string; done: number; total: number }, t: (k: string, p?: unknown) => string): string;
export function notifyOn(message: EngineMessage): { key: string; params?: unknown } | null;
```

- [x] **Step 1: Scrivere i test che falliscono**

`app/test/lifecycle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { notifyOn, onQuitRequested, onWindowClose, trayTooltip } from "../main/tray.ts";

describe("lifecycle", () => {
  it("hides the window instead of quitting while a book is being translated", () => {
    expect(onWindowClose(true)).toBe("hide");
  });

  it("quits when there is nothing running", () => {
    expect(onWindowClose(false)).toBe("quit");
  });

  it("asks for confirmation before quitting with work in flight", () => {
    expect(onQuitRequested(true)).toBe("confirm");
  });
});

describe("notifications", () => {
  it("notifies when a book is finished", () => {
    expect(notifyOn({ type: "done", summary: {} as never })?.key).toBe("notify.done");
  });

  it("notifies when a gate is waiting for the user", () => {
    expect(notifyOn({ type: "gate", gate: "terms" })?.key).toBe("notify.gate.terms");
  });

  it("says nothing about ordinary progress", () => {
    expect(notifyOn({ type: "progress", done: 3, total: 100 })).toBeNull();
  });
});

describe("trayTooltip", () => {
  it("builds the tooltip from the catalogue, never from a literal", () => {
    const t = (key: string) => `[${key}]`;
    expect(trayTooltip({ title: "Book", done: 5, total: 10 }, t)).toContain("[tray.translating]");
  });
});
```

- [x] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/lifecycle.test.ts`
Atteso: FAIL, `Cannot find module '../main/tray.ts'`.

- [x] **Step 3: Implementare**

Le decisioni del ciclo di vita sono funzioni pure, testate a parte da Electron: è il modo per verificarle senza avviare un'applicazione.

Con un progetto in traduzione, chiudere la finestra la nasconde e lascia l'icona in tray con stato e comandi (apri, pausa). A libro finito arriva una notifica di sistema; ne arriva una anche quando un gate aspetta l'utente, perché altrimenti una traduzione si ferma e nessuno lo sa. L'avanzamento ordinario **non** notifica.

Uscire davvero è un comando esplicito: con lavoro in corso chiede conferma, poi mette in pausa pulita — `signal.abort()`, attesa della chiusura dell'engine — prima di terminare.

Tooltip, menu e notifiche passano tutti dal catalogo.

- [x] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/lifecycle.test.ts`
Atteso: PASS, sette test.

- [x] **Step 5: Commit**

```bash
git add app/main/tray.ts app/main/main.ts app/test/lifecycle.test.ts
git commit -m "feat(app): closing the window is not quitting when a book is in flight"
```

---

### Task 9: Una traduzione intera, end-to-end, con un backend finto

**Files:**
- Create: `app/e2e/translate.spec.ts`
- Modify: `app/main/main.ts` (il gancio del backend finto)

**Interfaces:**
- Produces: la prova che tutto il piano regge insieme.

- [x] **Step 1: Scrivere il test che fallisce**

`app/e2e/translate.spec.ts` avvia l'applicazione con `BABELBOOK_FAKE_BACKEND=1`, crea un progetto da un EPUB generato, avvia la traduzione con entrambe le auto-accettazioni attive, aspetta lo stato `done`, e verifica che il file `output/*.it.epub` esista e contenga il testo tradotto dal finto.

Poi la seconda metà della prova: avvia una traduzione, la mette in pausa a metà, chiude e riapre l'applicazione, verifica che il progetto sia `paused` e non `running`, riprende, e verifica che il backend finto **non sia stato richiamato per le unità già tradotte**.

- [x] **Step 2: Eseguirlo e verificare che fallisca**

Run: `npm run test:e2e -w app`
Atteso: FAIL.

- [x] **Step 3: Implementare il gancio**

`BABELBOOK_FAKE_BACKEND` fa costruire al main un `LlmBackend` deterministico che risponde nel formato del piano 2 anteponendo un marcatore alla traduzione. Come le variabili del piano 3, si legge **in un punto solo** e si documenta lì.

- [x] **Step 4: Eseguire la prova**

Run: `npm run test:e2e -w app`
Atteso: PASS.

- [x] **Step 5: Commit**

```bash
git add app/e2e/translate.spec.ts app/main/main.ts
git commit -m "test(app): a whole book through the app, paused and resumed"
```

---

## Definizione di finito

- Tutta la suite verde, `npm run test:e2e -w app` compreso.
- Un libro attraversa l'applicazione dal file all'EPUB tradotto, con un backend finto.
- Una pausa a metà, un riavvio dell'applicazione e una ripresa non ritraducono ciò che era già fatto.
- Un progetto trovato in `running` all'avvio torna a `paused`.
- Le chiavi non compaiono in chiaro nel database né in nessuna risposta IPC.
- La macchina a stati vive in `core/`, non importa Electron, e i suoi test girano col resto del core.

## La prova che nessuna suite può dare

Prima di considerare finito il piano, **tradurre un libro vero con un provider vero**. I test coprono ogni modo in cui il backend può fallire, ma nessuno ne costruisce uno funzionante, perché servirebbe la rete: un errore di cablaggio in `resolve.ts` o in `sdk.ts` passerebbe l'intera suite.

Ordine consigliato: un libro corto, un modello economico, l'auto-accettazione spenta per vedere i due gate, e a fine corsa aprire l'EPUB in un lettore vero. È l'unico test che conta.
