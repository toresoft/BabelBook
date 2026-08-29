# La corsa osservabile e il discovery — piano di implementazione

**Stato: scritto, non iniziato.**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una corsa vera dice cosa sta facendo, quanto sta spendendo e con quale domanda — e ciò che decide di non tradurre si può leggere.

**Architecture:** Il progresso smette di essere un numero e diventa una coppia: quanto del libro è tradotto, che è un fatto del database, e cosa sta facendo la corsa adesso, che è un fatto della fase. I token smettono di essere contati da una fase sola e passano per un decoratore attorno al backend, montato una volta, che nessuna fase futura può dimenticare. Il code-index adotta le tre lezioni che il prototipo ha pagato e le conserva sotto una chiave propria, così correggerne la domanda non butta via le traduzioni. Le due schede che mostrano le unità smettono di mostrare il sorgente mascherato e leggono i byte veri.

**Tech Stack:** Node 24.18.0, TypeScript ESM con sola sintassi cancellabile in `core/`, node:sqlite, Electron, Angular 22.1, daisyUI 5, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-29-corsa-osservabile-e-discovery-design.md`

## Global Constraints

- **Codice e commenti in inglese.** Questo documento e la spec sono in italiano; il codice no.
- **`core/` non conosce Electron né SQLite**, ed è ESM con import `.ts` e **sola sintassi cancellabile**: niente `enum`, niente `namespace`, niente parameter properties.
- **`app/shared/*.ts` non dipende da niente.** I tipi che attraversano l'IPC non importano il processo main, altrimenti il compilatore Angular tira dentro tutto.
- **Ogni stringa esiste in `app/locales/en.json` e `app/locales/it.json`.** L'inglese è la lingua di riferimento del file; l'interfaccia parte in italiano.
- **La chiave API non arriva mai alla finestra.** Vale oggi e resta vero.
- **Tre migrazioni, non una.** La spec ne prevedeva una sola (009). Sono tre perché ogni task deve poter atterrare da solo, e un task che non può atterrare da solo non è un task: `009` (T3), `010` (T7), `011` (T10).
- Comandi dalla radice del repo salvo dove indicato. `export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`.
- Test: `npx vitest run <percorso>` per un file, `npm test` per tutto, `npm run test:ui -w app` per i componenti Angular, `npm run typecheck` sempre prima di commettere.
- **Parte da un albero che contiene il lavoro in corso** su `core/translate/instructions.ts`, `core/translate/versions.ts`, `app/main/run/cache-key.ts` e `LlmResult.reasoningTokens`. Se non è commesso, commetterlo prima di iniziare: questo piano lo dà per presente.

---

### Task 1: La fase viaggia insieme al progresso

`Progress` porta già la fase (`core/ports.ts:87`) e l'orchestratore la butta via nel tradurla in messaggio. Questo task la fa arrivare fino alla finestra, senza ancora produrne di nuove.

**Files:**
- Modify: `app/shared/dto.ts`, `app/shared/run.ts`, `app/shared/channels.ts`
- Modify: `app/main/run/engine-host.ts`, `app/main/run/orchestrator.ts`, `app/main/run/runtime.ts`
- Test: `app/test/engine-host.test.ts`, `app/test/orchestrator.test.ts`

**Interfaces:**
- Produces: `type RunPhase = "analyze" | "candidates" | "code-index" | "translate" | "compose"` in `app/shared/dto.ts`; `RUN_PHASES: readonly RunPhase[]` accanto; `EngineMessage` variante `{ type: "progress"; phase: RunPhase; done: number; total: number }`; evento `run.progress` con `phase`.

- [ ] **Step 1: Scrivi il test che fallisce**

In coda a `app/test/engine-host.test.ts`:

```typescript
describe("the progress message", () => {
  it("is refused when its phase is not one the run has", () => {
    expect(isEngineMessage({ type: "progress", phase: "sorting", done: 1, total: 2 })).toBe(false);
  });

  it("is accepted with a phase the run has", () => {
    expect(isEngineMessage({ type: "progress", phase: "code-index", done: 1, total: 2 })).toBe(true);
  });

  /**
   * A phase-less progress message is the shape of the previous protocol. It is
   * refused rather than defaulted: a bar that says "translating" while the
   * code index runs is worse than a bar that says nothing, because it is
   * believed.
   */
  it("is refused without a phase", () => {
    expect(isEngineMessage({ type: "progress", done: 1, total: 2 })).toBe(false);
  });
});
```

Se `isEngineMessage` non è esportato da `app/main/run/engine-host.ts`, esportalo: è la funzione che `case "progress"` usa a `engine-host.ts:47`.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/engine-host.test.ts`
Atteso: FAIL — il messaggio senza fase e quello con fase inventata passano entrambi.

- [ ] **Step 3: Aggiungi il tipo e la validazione**

In `app/shared/dto.ts`, accanto agli altri tipi che attraversano l'IPC:

```typescript
/**
 * The phases a run goes through, in the order it goes through them.
 *
 * It lives here, with the IPC vocabulary, because three parties need it: the
 * engine that emits it, the main process that forwards it, and the window that
 * names it. It mirrors `Progress["phase"]` in `core/ports.ts`, and the
 * orchestrator's `emit` is what holds the two together — a phase added there
 * and not here stops compiling.
 */
export type RunPhase = "analyze" | "candidates" | "code-index" | "translate" | "compose";

export const RUN_PHASES: readonly RunPhase[] = [
  "analyze", "candidates", "code-index", "translate", "compose",
];
```

In `app/shared/run.ts`, in testa: `import type { RunPhase } from "./dto.ts";`, riesporta `export type { RunPhase } from "./dto.ts";`, e cambia la variante:

```typescript
  | { type: "progress"; phase: RunPhase; done: number; total: number }
```

In `app/main/run/engine-host.ts`, al `case "progress"`:

```typescript
    case "progress":
      return typeof message.done === "number" && typeof message.total === "number"
        && RUN_PHASES.includes(message.phase as RunPhase);
```

con l'import di `RUN_PHASES` e `RunPhase` da `../../shared/dto.ts`.

In `app/main/run/orchestrator.ts:165`:

```typescript
      report(progress): void {
        emit({ type: "progress", phase: progress.phase, done: progress.done, total: progress.total });
      },
```

In `app/shared/channels.ts`, l'evento:

```typescript
  "run.progress": { projectId: string; phase: RunPhase; done: number; total: number };
```

con `RunPhase` aggiunto all'import e alla riesportazione dei tipi da `./dto.ts`.

In `app/main/run/runtime.ts:163`:

```typescript
    if (message.type === "progress") {
      deps.broadcast("run.progress", {
        projectId: activeId, phase: message.phase, done: message.done, total: message.total,
      });
      return;
    }
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx vitest run app/test/engine-host.test.ts app/test/orchestrator.test.ts && npm run typecheck`
Atteso: PASS. Il typecheck segnala i punti del renderer che si aspettano l'evento senza fase: aggiungi `phase` dove le prove dei componenti lo costruiscono, senza ancora usarlo.

- [ ] **Step 5: Commetti**

```bash
git add app/shared app/main/run app/test
git commit -m "feat(run): il progresso dice di quale fase parla"
```

---

### Task 2: Le due fasi mute imparano a contare

`extractCandidates` e `indexCodeBlocks` chiamano il modello e non riferiscono niente. Su un libro tecnico il code-index sono 298 chiamate in fila prima che la prima riga sia tradotta.

**Files:**
- Modify: `core/analyze/candidates.ts`, `core/analyze/code.ts`
- Modify: `app/main/run/orchestrator.ts`
- Test: `core/test/candidates.test.ts`, `core/test/code.test.ts`

**Interfaces:**
- Consumes: `ProgressSink` da `core/ports.ts`, `RunPhase` dal Task 1
- Produces: `ExtractInput.progress?: ProgressSink` in `candidates.ts`, `IndexInput.progress?: ProgressSink` in `code.ts`

- [ ] **Step 1: Scrivi i test che falliscono**

In coda a `core/test/code.test.ts`:

```typescript
/**
 * The bar is the only thing that separates a long phase from a hung one. This
 * phase is the longest in a run — one call per twenty blocks, on a real book
 * hundreds of them — and until now it reported nothing at all.
 */
it("reports one step per batch, against the number of batches", async () => {
  const units = Array.from({ length: 5 }, (_, at) => unit(at + 1, "text", "translate"));
  const seen: Array<{ phase: string; done: number; total: number }> = [];

  await indexCodeBlocks({
    units,
    // The reply form, not the scripted array: an array that runs out THROWS,
    // by design, and this test makes more calls than it cares to script.
    backend: new FakeBackend(() => ({
      text: "nothing in the format", tokensIn: 0, tokensOut: 0,
      reasoningTokens: 0, finishReason: "stop",
    })),
    sourceHash: "h",
    batchSize: 2,
    progress: { report: (p) => seen.push({ phase: p.phase, done: p.done, total: p.total }) },
  });

  // Three batches out of five units, and a step after each. The order is not
  // asserted: Task 8 sends the batches out in parallel, and a test that fixed
  // the order here would have to be rewritten there for no gain.
  expect(seen).toHaveLength(3);
  expect(seen.every((step) => step.phase === "code-index" && step.total === 3)).toBe(true);
  expect(new Set(seen.map((step) => step.done))).toEqual(new Set([1, 2, 3]));
});
```

`unit(n, source, state, reason?)` è la costante in testa a `core/test/code.test.ts`; `FakeBackend` viene da `core/test/fake/backend.ts`. La risposta non è nel formato e fa astenere tutti i batch: è voluto, il test misura il progresso, non i verdetti.

In coda a `core/test/candidates.test.ts`:

```typescript
it("reports one step per sample", async () => {
  const seen: Array<{ phase: string; done: number; total: number }> = [];
  await extractCandidates({
    units,
    // Answers nothing usable, for ever. The parsing fails on every sample,
    // and that is the point: the bar measures the questions asked, not the
    // answers understood — `answered` goes on measuring those.
    backend: new FakeBackend(() => ({
      text: "nothing in the format", tokensIn: 0, tokensOut: 0,
      reasoningTokens: 0, finishReason: "stop",
    })),
    sourceLanguage: "en",
    targetLanguage: "it",
    progress: { report: (p) => seen.push({ phase: p.phase, done: p.done, total: p.total }) },
  });

  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((step) => step.phase === "candidates")).toBe(true);
  expect(seen.map((step) => step.done)).toEqual(seen.map((_, at) => at + 1));
  expect(seen[seen.length - 1]!.done).toBe(seen[seen.length - 1]!.total);
});
```

`units` è la costante di sessanta unità in testa al file.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run core/test/code.test.ts core/test/candidates.test.ts`
Atteso: FAIL — `progress` non è una proprietà nota, e `seen` resta vuoto.

- [ ] **Step 3: Riferisci**

In `core/analyze/code.ts`, aggiungi a `IndexInput`:

```typescript
  /** Absent in the tests that only care about the verdicts. */
  progress?: ProgressSink;
```

con `import type { LlmBackend, ProgressSink } from "../ports.ts";`. Nel ciclo, calcola i batch prima di percorrerli e riferisci dopo ognuno:

```typescript
  const batches: TranslationUnit[][] = [];
  for (let at = 0; at < questionable.length; at += batchSize) {
    batches.push(questionable.slice(at, at + batchSize));
  }

  let judged = 0;
  for (const batch of batches) {
    // … il corpo attuale, con `batch` al posto di `questionable.slice(...)` …
    judged++;
    input.progress?.report({ phase: "code-index", done: judged, total: batches.length });
  }
```

In `core/analyze/candidates.ts`, aggiungi `progress?: ProgressSink` a `ExtractInput` e, dentro il ciclo `for (const sample of samples)`, dopo la chiamata e il parsing:

```typescript
    asked++;
    input.progress?.report({ phase: "candidates", done: asked, total: samples.length });
```

`asked` è un contatore nuovo che parte da zero e sale **anche quando il parsing fallisce**: la barra misura le domande fatte, non le risposte capite — `answered` continua a misurare quelle.

In `app/main/run/orchestrator.ts`, passa il sink alle due chiamate:

```typescript
      report = await extractCandidates({
        units: unitsBeforeTerms,
        backend,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        progress: { report: (p) => emit({ type: "progress", phase: p.phase, done: p.done, total: p.total }) },
        signal,
      });
```

e identicamente per `indexCodeBlocks`.

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx vitest run core/test/code.test.ts core/test/candidates.test.ts app/test/orchestrator.test.ts && npm run typecheck`
Atteso: PASS.

- [ ] **Step 5: Commetti**

```bash
git add core/analyze core/test app/main/run app/test
git commit -m "feat(run): le due fasi lunghe dicono a che punto sono"
```

---

### Task 3: Il contatore che nessuna fase può dimenticare

Oggi `translateUnits` conta solo sé stessa e `stoppedSummary` restituisce zero: una corsa fermata a un gate registra costo zero avendo pagato campioni e batch.

**Files:**
- Create: `core/translate/usage.ts`, `core/test/usage.test.ts`
- Create: `app/main/db/migrations/009-run-reasoning-tokens.sql`
- Modify: `app/shared/run.ts`, `app/shared/channels.ts`, `app/shared/dto.ts`
- Modify: `app/main/run/orchestrator.ts`, `app/main/run/engine-host.ts`, `app/main/run/runtime.ts`, `app/main/projects/detail.ts`
- Test: `app/test/orchestrator.test.ts`, `app/test/project-detail.test.ts`, `app/test/schema.test.ts`

**Interfaces:**
- Produces: `interface Usage { tokensIn: number; tokensOut: number; reasoningTokens: number }`; `function countingBackend(inner: LlmBackend, onUsage: (total: Usage) => void): LlmBackend`; `EngineMessage` variante `{ type: "usage"; tokensIn: number; tokensOut: number; reasoningTokens: number }`; evento `run.usage`; `RunSummary.reasoningTokens`; `ProjectDetail.tokens.reasoning`.

- [ ] **Step 1: Scrivi il test che fallisce**

`core/test/usage.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { countingBackend } from "../translate/usage.ts";
import type { Usage } from "../translate/usage.ts";

function backend(reasoning: number) {
  return {
    call: async () => ({
      text: "ok", tokensIn: 10, tokensOut: 4, reasoningTokens: reasoning, finishReason: "stop" as const,
    }),
  };
}

/**
 * A running total, never a delta.
 *
 * The number crosses a process boundary on its way to a row in the database.
 * A delta that is dropped there is lost for ever and the bill quietly
 * understates itself; a total that is dropped is corrected by the next one.
 */
describe("the counting backend", () => {
  it("hands out the running total after every call", async () => {
    const seen: Usage[] = [];
    const counted = countingBackend(backend(2), (total) => seen.push(total));

    await counted.call({ prompt: "one" });
    await counted.call({ prompt: "two" });

    expect(seen).toEqual([
      { tokensIn: 10, tokensOut: 4, reasoningTokens: 2 },
      { tokensIn: 20, tokensOut: 8, reasoningTokens: 4 },
    ]);
  });

  it("passes the answer through untouched", async () => {
    const counted = countingBackend(backend(0), () => {});
    expect((await counted.call({ prompt: "one" })).text).toBe("ok");
  });

  /**
   * A call that throws was still made and may still have been billed, but
   * nothing came back to count. Reporting a total unchanged is the honest
   * answer; inventing one would be worse than the silence it replaces.
   */
  it("does not report when the call throws", async () => {
    const seen: Usage[] = [];
    const counted = countingBackend(
      { call: async () => { throw new Error("nope"); } },
      (total) => seen.push(total),
    );

    await expect(counted.call({ prompt: "one" })).rejects.toThrow("nope");
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run core/test/usage.test.ts`
Atteso: FAIL — `core/translate/usage.ts` non esiste.

- [ ] **Step 3: Scrivi il decoratore**

`core/translate/usage.ts`:

```typescript
import type { LlmBackend } from "../ports.ts";

/** What a run has spent so far, in the three numbers a provider reports. */
export interface Usage {
  tokensIn: number;
  tokensOut: number;
  /** The share of `tokensOut` spent thinking rather than answering. */
  reasoningTokens: number;
}

/**
 * A backend that keeps the bill.
 *
 * A decorator rather than a parameter on each phase, because a phase added
 * later has to be remembered to count and this does not have to be remembered
 * at all: it is mounted once, around the backend every phase already shares.
 * Before it existed, only the translation counted, and a run that stopped at a
 * gate recorded a cost of zero having paid for everything that got it there.
 */
export function countingBackend(inner: LlmBackend, onUsage: (total: Usage) => void): LlmBackend {
  const total: Usage = { tokensIn: 0, tokensOut: 0, reasoningTokens: 0 };
  return {
    async call(input) {
      const result = await inner.call(input);
      total.tokensIn += result.tokensIn;
      total.tokensOut += result.tokensOut;
      total.reasoningTokens += result.reasoningTokens;
      onUsage({ ...total });
      return result;
    },
  };
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run core/test/usage.test.ts`
Atteso: PASS.

- [ ] **Step 5: Scrivi il test del montaggio, e falli fallire**

In coda a `app/test/orchestrator.test.ts`:

```typescript
/**
 * The failure this test exists for: a run that stops at the terms gate has
 * already paid for the sampling, and used to record zero.
 */
it("reports what it spent even when it stops at a gate", async () => {
  const store = new FakeStore([unit(1)]);
  const { seen, emit } = collect();

  const summary = await runProject({
    store,
    backend: scriptedBackend(),
    config: config(),
    emit,
    signal: new AbortController().signal,
  });

  const usage = seen.filter((message) => message.type === "usage");
  expect(usage.length).toBeGreaterThan(0);
  // `scriptedBackend` answers the sampling with tokensIn: 10, and the run
  // stops at the terms gate right after. Before the counter existed this
  // summary said zero — a book's worth of sampling, recorded as free.
  expect(summary.tokensIn).toBe(10);
  expect(summary.tokensIn).toBe(usage[usage.length - 1]!.tokensIn);
});
```

`store`, `collect`, `config` e `scriptedBackend` sono gli helper in testa a `app/test/orchestrator.test.ts`, usati esattamente come nel test «returns at the terms gate without spending on a later phase» che sta poco sopra.

Run: `npx vitest run app/test/orchestrator.test.ts`
Atteso: FAIL — nessun messaggio `usage`, e `summary.tokensIn` è 0.

- [ ] **Step 6: Monta il contatore nell'orchestratore**

In `app/shared/run.ts`, la variante nuova e il campo nel sommario:

```typescript
  | { type: "usage"; tokensIn: number; tokensOut: number; reasoningTokens: number }
```

```typescript
export interface RunSummary {
  units: { total: number; translated: number; fellBack: number; identical: number };
  notTranslated: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  /** Part of `tokensOut`, not on top of it: what was spent thinking. */
  reasoningTokens: number;
}
```

In `app/main/run/engine-host.ts`, la validazione:

```typescript
    case "usage":
      return typeof message.tokensIn === "number" && typeof message.tokensOut === "number"
        && typeof message.reasoningTokens === "number";
```

In `app/main/run/orchestrator.ts`, in testa a `runProject`, prima di ogni uso di `deps.backend`:

```typescript
  const spent: Usage = { tokensIn: 0, tokensOut: 0, reasoningTokens: 0 };
  const backend = countingBackend(deps.backend, (total) => {
    spent.tokensIn = total.tokensIn;
    spent.tokensOut = total.tokensOut;
    spent.reasoningTokens = total.reasoningTokens;
    emit({ type: "usage", ...total });
  });
```

e togli `backend` dalla destrutturazione di `deps` in cima, che ora lo ombrerebbe. `summaryBeforeTranslation` prende `spent` come terzo argomento e lo riversa al posto degli zeri:

```typescript
    tokensIn: spent.tokensIn,
    tokensOut: spent.tokensOut,
    reasoningTokens: spent.reasoningTokens,
```

e in fondo, il sommario della traduzione porta i totali della corsa, non quelli della sola fase:

```typescript
  return { ...summary, tokensIn: spent.tokensIn, tokensOut: spent.tokensOut, reasoningTokens: spent.reasoningTokens };
```

`translateUnits` continua a contare i propri: è ciò che il report attribuisce alla traduzione, e resta dov'è.

- [ ] **Step 7: Esegui i test e verifica che passino**

Run: `npx vitest run app/test/orchestrator.test.ts core/test/engine.test.ts`
Atteso: PASS. `core/test/engine.test.ts` chiede `reasoningTokens` nei sommari costruiti a mano: aggiungilo.

- [ ] **Step 8: Scrivi il test della persistenza, e fallo fallire**

In coda a `app/test/project-detail.test.ts`:

```typescript
it("shows the tokens of a run still going, not only of one finished", () => {
  const db = seeded("running");
  db.prepare(`
    INSERT INTO run (id, project_id, phase, started_at, tokens_in, tokens_out, reasoning_tokens)
    VALUES ('r1','p1','translate','2026-08-29',120,30,8)
  `).run();

  const detail = projectDetail(db, "p1")!;
  expect(detail.tokens).toEqual({ in: 120, out: 30, reasoning: 8 });
});
```

`seeded(state)` è l'helper in testa a `app/test/project-detail.test.ts`. La riga `run` è inserita **senza** `ended_at`: è il caso che prima non esisteva, perché i token si scrivevano solo alla fine.

Run: `npx vitest run app/test/project-detail.test.ts`
Atteso: FAIL — la colonna `reasoning_tokens` non esiste.

- [ ] **Step 9: Migrazione, persistenza e canale**

`app/main/db/migrations/009-run-reasoning-tokens.sql`:

```sql
-- What a run spent thinking rather than answering. Part of tokens_out, never
-- on top of it: a provider bills it as output. Kept apart because it is the
-- one number that explains an answer that came back empty and was paid in
-- full — a reasoning model with no output budget of its own spends all of it
-- before the format begins.
ALTER TABLE run ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
```

In `app/shared/channels.ts`, l'evento e il suo nome nella lista `EVENTS`:

```typescript
  "run.usage": { projectId: string; tokensIn: number; tokensOut: number; reasoningTokens: number };
```

In `app/shared/dto.ts`, `ProjectDetail.tokens` diventa `{ in: number; out: number; reasoning: number }`.

In `app/main/projects/detail.ts`, somma la colonna nuova accanto alle altre due e riversala in `tokens.reasoning`.

In `app/main/run/runtime.ts`, dentro `onEngineMessage`, prima del ramo `done`:

```typescript
    if (message.type === "usage") {
      // Written as it arrives, not at the end. A run that stops at a gate, is
      // paused, or dies with the process has still spent what it spent, and
      // the row is the only place that survives to say so.
      if (activeRunId !== null) {
        const cost = costOf(activeId, message.tokensIn, message.tokensOut);
        db.prepare(
          "UPDATE run SET tokens_in = ?, tokens_out = ?, reasoning_tokens = ?, cost = ? WHERE id = ?",
        ).run(message.tokensIn, message.tokensOut, message.reasoningTokens, cost, activeRunId);
      }
      deps.broadcast("run.usage", {
        projectId: activeId,
        tokensIn: message.tokensIn,
        tokensOut: message.tokensOut,
        reasoningTokens: message.reasoningTokens,
      });
      return;
    }
```

`costOf(projectId, tokensIn, tokensOut)` è l'aritmetica che il ramo `done` fa già in linea (`modelPricesOf` più `priceTokens`), estratta in una funzione locale del modulo e chiamata da entrambi. Il ramo `done` conserva la sola scrittura di `ended_at` più i totali finali, che ora coincidono con l'ultimo `usage`.

- [ ] **Step 10: Esegui tutto e verifica**

Run: `npm test && npm run typecheck`
Atteso: PASS. `app/test/schema.test.ts` conta le migrazioni: aggiorna il numero atteso.

- [ ] **Step 11: Commetti**

```bash
git add core/translate/usage.ts core/test/usage.test.ts app/shared app/main app/test
git commit -m "feat(run): il conto sale mentre la corsa spende, in ogni fase"
```

---

### Task 4: Due barre, perché sono due domande

**Files:**
- Modify: `app/renderer/src/app/project/project.ts`, `app/renderer/src/app/project/project.html`, `app/renderer/src/app/project/project.css`
- Modify: `app/locales/en.json`, `app/locales/it.json`
- Test: `app/renderer/src/app/project/project.spec.ts`

**Interfaces:**
- Consumes: eventi `run.progress` (con `phase`) e `run.usage` dai Task 1 e 3

- [ ] **Step 1: Scrivi il test che fallisce**

Il finto IPC di questa suite ha `on: () => () => {}` e non emette niente, quindi prima serve un finto che emetta. In `app/renderer/src/app/project/project.spec.ts`, accanto a `bridge` e `mount`:

```typescript
/** The event side of the bridge, which `mount`'s stub does not have. */
function events() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  return {
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return () => {};
    },
    emit: (channel: string, payload: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
}
```

`mount` guadagna un secondo parametro opzionale, `bus = events()`, che finisce in `{ provide: IpcService, useValue: { invoke, on: bus.on } }`, e lo restituisce insieme a `fixture`. I test esistenti non cambiano.

Poi, in coda al file:

```typescript
it("shows the phase and its own counter while a run is going", async () => {
  const { fixture, bus } = mount(bridge({ ...detail, state: "running" }));
  await fixture.whenStable();

  bus.emit("run.progress", { projectId: "p1", phase: "code-index", done: 7, total: 298 });
  fixture.detectChanges();

  const bar = fixture.nativeElement.querySelector("[data-testid=phase-progress]");
  expect(bar).not.toBeNull();
  expect(bar.getAttribute("value")).toBe("2");
  expect(fixture.nativeElement.querySelector("[data-testid=phase-counts]").textContent)
    .toContain("7");
});

/**
 * A phase bar left on screen after the run is a lie with a date on it.
 */
it("drops the phase bar when the run ends", async () => {
  const { fixture, bus } = mount(bridge({ ...detail, state: "done" }));
  await fixture.whenStable();

  bus.emit("run.progress", { projectId: "p1", phase: "translate", done: 3, total: 9 });
  fixture.detectChanges();
  expect(fixture.nativeElement.querySelector("[data-testid=phase-progress]")).not.toBeNull();

  bus.emit("project.changed", { id: "p1" });
  await fixture.whenStable();
  fixture.detectChanges();

  expect(fixture.nativeElement.querySelector("[data-testid=phase-progress]")).toBeNull();
});
```

`detail` è la costante di `ProjectDetail` in testa al file. Il secondo test ricarica un progetto che non è più `running`, che è la condizione con cui la barra di fase si azzera.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npm run test:ui -w app`
Atteso: FAIL — `[data-testid=phase-progress]` non esiste.

- [ ] **Step 3: Aggiungi il segnale e la barra**

In `app/renderer/src/app/project/project.ts`:

```typescript
  /**
   * What the run is doing right now, which is not what the book is.
   *
   * Two numbers, not one. `project.progress` says how much of the book is
   * translated: a fact of the database, monotone, true with nothing running.
   * This says how far the current phase has got, and it restarts at every
   * phase. Conflated, they made a bar that was the first but moved only during
   * the last phase of the second — correctly still, and unreadably so.
   */
  readonly phaseProgress = signal<{ phase: RunPhase; done: number; total: number } | null>(null);
```

Nella sottoscrizione a `run.progress`, oltre a quello che fa già:

```typescript
      this.phaseProgress.set({ phase: progress.phase, done: progress.done, total: progress.total });
```

e azzeralo — `this.phaseProgress.set(null)` — dentro il ricaricamento su `project.changed` quando lo stato ricaricato non è `running`, e in `pause()`.

Aggiungi anche il segnale dei token, alimentato da `run.usage`, che sovrascrive `found.tokens` finché la corsa vive.

In `app/renderer/src/app/project/project.html`, sotto la barra del libro:

```html
    @if (phaseProgress(); as running) {
      <div class="project__phase-bar">
        <span class="project__phase-name">{{ t('phase.' + running.phase) }}</span>
        @if (running.total > 0) {
          <progress
            class="progress progress-primary"
            max="100"
            data-testid="phase-progress"
            [value]="phasePercent(running)"></progress>
          <span class="project__phase-counts" data-testid="phase-counts">
            {{ t('library.progress', { done: running.done, total: running.total }) }}
          </span>
        } @else {
          <!-- A bar that moves without claiming progress: the same rule the
               splash follows, for the same reason — a bar that filled up
               would be inventing a total nobody has. -->
          <progress class="progress progress-primary" data-testid="phase-progress"></progress>
        }
      </div>
    }
```

`phasePercent` è `Math.round((done / total) * 100)` con la guardia su `total === 0`, come già fa `percent`.

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm run test:ui -w app && npm run typecheck`
Atteso: PASS.

- [ ] **Step 5: Commetti**

```bash
git add app/renderer app/locales
git commit -m "feat(ui): la barra del libro e quella della fase, che sono due cose"
```

---

### Task 5: Un marcatore di pagina non è qualcosa da leggere

Il libro misurato mette i segnalibri di pagina dentro i listati: `<pre><code><span aria-label="199" epub:type="pagebreak" .../>…`. Nasce un'unità attributo che eredita lo stato `code` del blocco, e il listato compare come **due voci** — una vuota e una che dice `199` — 101 volte su 1147.

**Files:**
- Modify: `core/epub/blocks.ts`
- Test: `core/test/blocks.test.ts`

**Interfaces:**
- Produces: nessuna nuova esportazione; cambia cosa `extract` restituisce

- [ ] **Step 1: Scrivi il test che fallisce**

In coda a `core/test/blocks.test.ts`:

```typescript
/**
 * A page marker records where a printed page began. It is not content, in any
 * state: translating "199" is meaningless, and listing it as an exclusion put
 * a second, mysterious row beside every code listing that carried one.
 *
 * The rule reads the element, never the value. An `aria-label` that is only a
 * number could be anything; a `doc-pagebreak` could not.
 */
describe("a page marker", () => {
  it("makes no unit of its own inside a listing", () => {
    const { units } = extract({
      doc: "c1.xhtml",
      source: `<html><body><pre><code><span aria-label="199" epub:type="pagebreak"`
        + ` id="pg_199" role="doc-pagebreak"/>const a = 1;</code></pre></body></html>`,
    });

    expect(units.map((unit) => unit.kind)).toEqual(["block"]);
    expect(units[0]!.state).toBe("code");
  });

  it("makes no unit in a paragraph either", () => {
    const { units } = extract({
      doc: "c1.xhtml",
      source: `<html><body><p><span aria-label="12" role="doc-pagebreak"/>A sentence.</p></body></html>`,
    });

    expect(units.filter((unit) => unit.kind === "attribute")).toEqual([]);
  });

  /** The rule is the marker's, not the attribute's: an ordinary label stays. */
  it("leaves an aria-label that labels something", () => {
    const { units } = extract({
      doc: "c1.xhtml",
      source: `<html><body><p><span aria-label="Home">A sentence.</span></p></body></html>`,
    });

    expect(units.filter((unit) => unit.kind === "attribute").map((unit) => unit.source))
      .toEqual(["Home"]);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run core/test/blocks.test.ts`
Atteso: FAIL — le prime due asserzioni trovano un'unità attributo in più.

- [ ] **Step 3: Riconosci il marcatore**

In `core/epub/blocks.ts`, accanto a `classesOf`:

```typescript
/**
 * An element that records where a printed page began, rather than something a
 * reader reads.
 *
 * Recognised by what the element declares — `epub:type="pagebreak"` or
 * `role="doc-pagebreak"` — and never by what its label contains. A label that
 * is only digits could be a figure number, a footnote or a year; a declared
 * page break could not be anything else.
 */
function isPageMarker(node: ElementNode): boolean {
  const declared = (attrValue(node, "epub:type") ?? "").split(/\s+/);
  if (declared.includes("pagebreak")) return true;
  return (attrValue(node, "role") ?? "").split(/\s+/).includes("doc-pagebreak");
}
```

e nel ciclo che raccoglie gli attributi traducibili (`blocks.ts:301`), prima di percorrerli:

```typescript
      if (!isPageMarker(child)) {
        for (const name of translatableAttributes(child.name)) {
          // … il corpo attuale …
        }
      }
```

Il segnaposto del `<span>` continua a nascere e a essere riprodotto byte per byte: quello che sparisce è l'unità, non il markup.

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx vitest run core/test/blocks.test.ts core/test/invariants.test.ts core/test/splice.test.ts && npm test`
Atteso: PASS. Le prove di riempimento nullo su libri veri devono restare byte per byte: se `splice` o `invariants` cadono, il segnaposto è stato toccato ed è un difetto di questo task.

- [ ] **Step 5: Commetti**

```bash
git add core/epub/blocks.ts core/test/blocks.test.ts
git commit -m "fix(epub): il numero di pagina dentro un listato non e' una voce"
```

---

### Task 6: Le due schede mostrano il testo, non la maschera

Le schede Esclusioni e Unità mostrano `source_text`, che è mascherato: per un `<pre><code>…</code></pre>` il testo è letteralmente `<0></0>`. Sul libro misurato, **1147 unità di codice su 1147** si presentano così, in un gruppo piatto unico senza documento né posizione.

**Files:**
- Create: `app/main/units/display.ts`, `app/test/display.test.ts`
- Modify: `app/main/exclusions/review.ts`, `app/main/units/list.ts`, `app/shared/dto.ts`
- Modify: `app/renderer/src/app/project/exclusions/exclusions.html`, `.css`
- Modify: `app/locales/en.json`, `app/locales/it.json`
- Test: `app/test/exclusions.test.ts`, `app/test/units.test.ts` (o il file che copre `listUnits`)

**Interfaces:**
- Produces: `function displayText(rawText: string | null, sourceText: string): string`; `ExclusionGroup.doc: string` e `units[].ordinal: number`

- [ ] **Step 1: Scrivi il test che fallisce**

`app/test/display.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { displayText } from "../main/units/display.ts";

/**
 * What the two tabs that list units are meant to show.
 *
 * `source_text` is masked: a `<pre><code>…</code></pre>` collapses to the
 * placeholder `<0></0>` and reads as an empty row. On a real technical book
 * that was every single code listing — a wall of identical blanks, which is
 * what "the discovery got worse" turned out to mean.
 *
 * `raw_text` holds the bytes, and the bytes are the answer. They carry markup
 * and entities, so they are stripped and decoded here, never interpreted:
 * this is text for a person to read, not HTML for a browser to run.
 */
describe("the text a unit is shown as", () => {
  it("is the code itself, not the placeholder that masks it", () => {
    expect(displayText("<code>const a = 1;</code>", "<0></0>")).toBe("const a = 1;");
  });

  it("decodes the entities the bytes carry", () => {
    expect(displayText("<code>if (a &lt; b) {}</code>", "<0></0>")).toBe("if (a < b) {}");
  });

  it("keeps the line breaks of a listing", () => {
    expect(displayText("<code>one\r\ntwo</code>", "<0></0>")).toBe("one\ntwo");
  });

  /** A row written before `raw_text` existed still has to show something. */
  it("falls back to the masked source when there are no bytes", () => {
    expect(displayText(null, "A sentence.")).toBe("A sentence.");
  });

  /** The page marker's own tag is markup, and leaves nothing behind. */
  it("drops a self-closing marker without leaving a gap", () => {
    expect(displayText(`<code><span aria-label="199" epub:type="pagebreak"/>const a = 1;</code>`, "<0></0>"))
      .toBe("const a = 1;");
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/display.test.ts`
Atteso: FAIL — `app/main/units/display.ts` non esiste.

- [ ] **Step 3: Scrivi il resa**

`app/main/units/display.ts`:

```typescript
import { decodeEntities } from "../../../core/epub/index.ts";

/**
 * A unit as a person reads it on screen.
 *
 * Never as HTML. The result goes into a text node in the window, so a book
 * that contains markup shows its markup rather than running it.
 */
export function displayText(rawText: string | null, sourceText: string): string {
  if (rawText === null) return sourceText;
  const withoutTags = rawText.replace(/<[^>]*>/g, "");
  return decodeEntities(withoutTags).replace(/\r\n/g, "\n").trim();
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run app/test/display.test.ts`
Atteso: PASS.

- [ ] **Step 5: Scrivi il test delle due schede, e fallo fallire**

In coda a `app/test/exclusions.test.ts`:

```typescript
it("shows the code of a listing, and where it is", () => {
  const db = seeded();
  db.prepare(`
    INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                      range_start, range_end, state, source_text, raw_text)
    VALUES ('u5','p1','d1',5,'c1.xhtml#5',9,10,'code','<0></0>','<code>const a = 1;</code>')
  `).run();

  const groups = listExclusions(db, "p1");
  const listing = groups.flatMap((group) => group.units).find((unit) => unit.unitId === "c1.xhtml#5")!;

  expect(listing.text).toBe("const a = 1;");
  expect(listing.ordinal).toBe(5);
});

/**
 * Grouped by state and reason alone, a technical book is one group of twelve
 * hundred rows. The document is what turns that back into questions a person
 * can answer one at a time.
 */
it("splits the groups by document", () => {
  const db = seeded();
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d2','p1','c2.xhtml',2)").run();
  db.prepare(`
    INSERT INTO unit (id, project_id, document_id, ordinal, unit_id,
                      range_start, range_end, state, reason, source_text, raw_text)
    VALUES ('u5','p1','d2',1,'c2.xhtml#1',0,1,'code','css-code-surface','x','x')
  `).run();

  const docs = listExclusions(db, "p1")
    .filter((group) => group.reason === "css-code-surface")
    .map((group) => group.doc);

  expect(new Set(docs)).toEqual(new Set(["c1.xhtml", "c2.xhtml"]));
});
```

Run: `npx vitest run app/test/exclusions.test.ts`
Atteso: FAIL — `text` è `<0></0>`, e `doc` non esiste sul gruppo.

- [ ] **Step 6: Leggi i byte in tutte e due**

In `app/shared/dto.ts`:

```typescript
export interface ExclusionGroup {
  state: ExcludedState | "translate";
  reason: string | null;
  /** The document these belong to: without it a technical book is one group of twelve hundred. */
  doc: string;
  units: Array<{ unitId: string; ordinal: number; text: string; forced: boolean }>;
}
```

In `app/main/exclusions/review.ts`, aggiungi `raw_text` e la giunzione con `project_document` alla query, ordina per `d.spine_order, u.ordinal`, componi la chiave del gruppo come `${effective} ${reason ?? ""} ${zip_path}`, e passa il testo per `displayText(row.raw_text, row.source_text)`.

In `app/main/units/list.ts`, aggiungi `u.raw_text` alla `SELECT` e riversa `source: displayText(row.raw_text, row.source_text)`. La ricerca continua a filtrare su `u.source_text`: è il testo su cui gli indici e le altre query ragionano, e cambiarlo qui è un'altra decisione.

In `app/renderer/src/app/project/exclusions/exclusions.html`, l'intestazione del gruppo porta anche `group.doc`, la voce porta `unit.ordinal`, e `.unit__text` prende `white-space: pre-wrap` con un carattere a spaziatura fissa e un tetto d'altezza con `overflow: auto` — un listato lungo scorre nella propria scatola invece di allungare la pagina.

- [ ] **Step 7: Esegui i test e verifica che passino**

Run: `npm test && npm run test:ui -w app && npm run typecheck`
Atteso: PASS. La chiave `track` del gruppo nel template include `group.doc`.

- [ ] **Step 8: Commetti**

```bash
git add app/main app/shared app/renderer app/locales app/test
git commit -m "fix(ui): un listato si legge, e si sa in quale documento sta"
```

---

### Task 7: L'unità dice qual è il suo elemento e la sua classe

Il commento di Translator chiama la classe del blocco *«esattamente il segnale che questo passaggio chiede di pesare»*, e avverte di non leggerla da `raw`: per un blocco, `raw` è il **contenuto**, quindi una classe letta lì è quella del primo discendente. babelBook non la porta affatto. Il Task 8 ne ha bisogno.

**Files:**
- Modify: `core/epub/blocks.ts`
- Create: `app/main/db/migrations/010-unit-element.sql`
- Modify: `app/main/db/store.ts`, e il punto dell'ingestione che scrive le righe `unit`
- Test: `core/test/blocks.test.ts`, `app/test/store-contract.test.ts`, `app/test/schema.test.ts`

**Interfaces:**
- Produces: `TranslationUnit.element?: string` e `TranslationUnit.className?: string`; colonne `unit.element` e `unit.class_name`

- [ ] **Step 1: Scrivi il test che fallisce**

In coda a `core/test/blocks.test.ts`:

```typescript
/**
 * The block's own element and class, not its first descendant's.
 *
 * A block's `raw` is its CONTENT, so reading a class out of it answers about
 * whatever is inside. The extractor has the node in hand and is the only place
 * that does.
 */
describe("what a unit says about its own markup", () => {
  it("carries the element and the first class of the block", () => {
    const { units } = extract({
      doc: "c1.xhtml",
      source: `<html><body><p class="TX first"><span class="mono">A sentence.</span></p></body></html>`,
    });

    expect(units[0]!.element).toBe("p");
    expect(units[0]!.className).toBe("TX");
  });

  it("says the element even when there is no class", () => {
    const { units } = extract({ doc: "c1.xhtml", source: "<html><body><pre>code</pre></body></html>" });
    expect(units[0]!.element).toBe("pre");
    expect(units[0]!.className).toBeUndefined();
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run core/test/blocks.test.ts`
Atteso: FAIL — `element` non è una proprietà di `TranslationUnit`.

- [ ] **Step 3: Portali sull'unità**

In `core/epub/blocks.ts`, su `TranslationUnit`:

```typescript
  /** The element the unit was cut at, when it was cut at one. */
  element?: string;
  /**
   * Its first class, when it has one.
   *
   * From the node, never from `raw`: a block's `raw` is its content, so a
   * class read out of it belongs to the first descendant — and the class is
   * exactly the signal the code index asks a model to weigh.
   */
  className?: string;
```

e in `emit`, accanto agli altri campi:

```typescript
      ...(node === null ? {} : { element: node.name }),
      ...(node === null || classesOf(node)[0] === undefined ? {} : { className: classesOf(node)[0] }),
```

Le unità **attributo** e quelle di **testo sciolto** non ne prendono nessuno, e il campo resta assente: la prima non è un elemento, la seconda non ne ha uno. Dare loro quello del blocco che le contiene sarebbe scrivere in tabella un fatto sbagliato per far tornare un'etichetta — e l'etichetta è esattamente ciò di cui il Task 8 si fida.

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `npx vitest run core/test/blocks.test.ts`
Atteso: PASS.

- [ ] **Step 5: Scrivi il test del giro completo, e fallo fallire**

In coda a `app/test/store-contract.test.ts`:

```typescript
it("gives back the element and the class it was given", async () => {
  const store = seeded([{
    id: "c1.xhtml#1", kind: "block", doc: "c1.xhtml", ordinal: 1, range: [0, 10],
    source: "A sentence.", raw: "A sentence.", state: "translate",
    element: "p", className: "TX",
  }]);

  const [unit] = await store.units();
  expect(unit!.element).toBe("p");
  expect(unit!.className).toBe("TX");
});
```

`seeded(units)` è l'helper in testa a `app/test/store-contract.test.ts`: prende le unità e le scrive col percorso di ingestione vero, che è ciò che rende questo un test del giro completo e non della sola lettura.

Run: `npx vitest run app/test/store-contract.test.ts`
Atteso: FAIL — le colonne non esistono.

- [ ] **Step 6: Migrazione, scrittura e lettura**

`app/main/db/migrations/010-unit-element.sql`:

```sql
-- The element a unit was cut at, and its first class.
--
-- The code index shows them to the model beside the text, because "pre.code"
-- and "p.TX" are the strongest signal about what a block is, and the strongest
-- one this application was throwing away. Null on rows written before this
-- migration: the index then judges on the text alone, as it did.
ALTER TABLE unit ADD COLUMN element TEXT;
ALTER TABLE unit ADD COLUMN class_name TEXT;
```

In `app/main/db/store.ts`, aggiungi le due colonne alla `SELECT` di `#toUnit` (`store.ts:57`) e riversale con lo stesso schema condizionale degli altri campi opzionali. Nel punto dell'ingestione che inserisce le righe `unit`, scrivi `unit.element ?? null` e `unit.className ?? null`.

- [ ] **Step 7: Esegui tutto e verifica**

Run: `npm test && npm run typecheck`
Atteso: PASS. Aggiorna il numero di migrazioni atteso in `app/test/schema.test.ts`.

- [ ] **Step 8: Commetti**

```bash
git add core/epub/blocks.ts core/test app/main/db app/test
git commit -m "feat(epub): l'unita' porta il proprio elemento e la propria classe"
```

---

### Task 8: Il code-index chiede la domanda del traduttore

`core/analyze/code.ts` è la versione 1 del classificatore, quella che il prototipo ha già pagato: *«troncati e chiesto "is this code?", il modello chiamò codice 432 blocchi su un libro vero, almeno 86 dei quali prosa semplice»*, e dopo la correzione *«i falsi positivi residui erano quasi tutti una riga sola: "The code files for the chapter can be found at https://…"»*.

**Files:**
- Create: `core/analyze/code-wire.ts`, `core/test/code-wire.test.ts`
- Modify: `core/analyze/code.ts`
- Test: `core/test/code.test.ts`

**Interfaces:**
- Consumes: `TranslationUnit.element` e `TranslationUnit.className` dal Task 7
- Produces: `interface CodeBatch { index: number; total: number; units: TranslationUnit[] }`; `function batchUnits(units, perBatch?): CodeBatch[]`; `function buildCodePrompt(batch: CodeBatch, retryReason?: string): string`; `function parseCodeVerdict(raw: string, batch: CodeBatch): { ok: true; code: Set<string>; prose: Set<string> } | { ok: false; reason: string }`

- [ ] **Step 1: Scrivi i test che falliscono**

`core/test/code-wire.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { batchUnits, buildCodePrompt, parseCodeVerdict } from "../analyze/code-wire.ts";
import type { TranslationUnit } from "../epub/index.ts";

function unit(id: string, source: string, element = "p", className?: string): TranslationUnit {
  return {
    id, kind: "block", doc: "c1.xhtml", ordinal: 1, range: [0, 1],
    source, raw: source, state: "translate", element,
    ...(className === undefined ? {} : { className }),
  };
}

describe("the code-index wire", () => {
  /**
   * The whole block on one line. A listing carries its own newlines, and a
   * format that puts one block per line cannot survive them: the answer comes
   * back misaligned and the batch abstains in silence.
   */
  it("flattens a multi-line listing onto a single line", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "const a = 1;\nconst b = 2;", "pre")])[0]!;
    const body = buildCodePrompt(batch).split("\n").filter((line) => line.startsWith("[1]"));

    expect(body).toHaveLength(1);
    expect(body[0]).toContain("const a = 1; const b = 2;");
  });

  it("shows the element and its class beside the text", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "A sentence.", "p", "TX")])[0]!;
    expect(buildCodePrompt(batch)).toContain("p.TX");
  });

  /**
   * Compact ordinals, not unit ids. An id is `c1.xhtml#1247`; asking a model
   * to echo twelve hundred of them exactly is paying for tokens to buy a
   * transcription error.
   */
  it("asks for ordinals and maps them back to the ids", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "one"), unit("c1.xhtml#2", "two")])[0]!;
    const verdict = parseCodeVerdict(
      "#CODEVERDICT v1 batch=1/1 count=2\n[1] keep\n[2] translate\n@end",
      batch,
    );

    expect(verdict).toEqual({ ok: true, code: new Set(["c1.xhtml#1"]), prose: new Set(["c1.xhtml#2"]) });
  });

  /**
   * A block that contains the word the old format terminated on used to end
   * the parsing early, and the rest of the batch vanished.
   */
  it("is not terminated by a block that contains the terminator", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "END", "pre"), unit("c1.xhtml#2", "two")])[0]!;
    const verdict = parseCodeVerdict(
      "#CODEVERDICT v1 batch=1/1 count=2\n[1] keep\n[2] translate\n@end",
      batch,
    );

    expect(verdict.ok).toBe(true);
  });

  it("refuses a count that does not match what was asked", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "one"), unit("c1.xhtml#2", "two")])[0]!;
    const verdict = parseCodeVerdict("#CODEVERDICT v1 batch=1/1 count=1\n[1] keep\n@end", batch);
    expect(verdict).toEqual({ ok: false, reason: "expected count 2, found 1" });
  });

  /** The older vocabulary is out of date, not wrong. */
  it("still reads code and prose", () => {
    const batch = batchUnits([unit("c1.xhtml#1", "one")])[0]!;
    const verdict = parseCodeVerdict("#CODEVERDICT v1 batch=1/1 count=1\n[1] code\n@end", batch);
    expect(verdict).toEqual({ ok: true, code: new Set(["c1.xhtml#1"]), prose: new Set() });
  });
});

/**
 * The question this pass asks is the translator's, not a classifier's. Asked
 * "is this code?", a model calls a sentence about `AuthModule` code; asked
 * "would you translate it?", it does not. The prompt is a contract, so the
 * words that carry the change are asserted rather than left to a reading.
 */
describe("the question", () => {
  it("asks what a translator would do, and about the whole line", () => {
    const prompt = buildCodePrompt(batchUnits([unit("c1.xhtml#1", "one")])[0]!);
    expect(prompt).toContain("TRANSLATE it, or KEEP it exactly as it is");
    expect(prompt).toContain("Judge the whole line, never the parts inside it");
  });

  it("carries the reason the previous attempt was refused", () => {
    const prompt = buildCodePrompt(batchUnits([unit("c1.xhtml#1", "one")])[0]!, "terminator @end not found");
    expect(prompt).toContain("terminator @end not found");
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run core/test/code-wire.test.ts`
Atteso: FAIL — `core/analyze/code-wire.ts` non esiste.

- [ ] **Step 3: Scrivi il trasporto**

`core/analyze/code-wire.ts` — porta la forma di `Translator/src/analyze/code-wire.ts`, con i tipi di questo repository:

```typescript
import type { TranslationUnit } from "../epub/index.ts";

/**
 * Blocks per batch.
 *
 * Sixty, not twenty. Each line carries the whole block, so a batch is worth
 * roughly three times the tokens of a truncated one — and at twenty, a real
 * technical book is 298 round trips before the first line is translated.
 */
const PER_BATCH = 60;

export interface CodeBatch {
  index: number;
  total: number;
  units: TranslationUnit[];
}

export function batchUnits(units: TranslationUnit[], perBatch: number = PER_BATCH): CodeBatch[] {
  const groups: TranslationUnit[][] = [];
  for (let at = 0; at < units.length; at += perBatch) groups.push(units.slice(at, at + perBatch));
  return groups.map((units, at) => ({ index: at + 1, total: groups.length, units }));
}

/**
 * `pre.code`, or `p` — the element and its first class, from the unit itself.
 *
 * From the unit and never from `raw`: a block's `raw` is its CONTENT, so a
 * class read out of it belongs to the first descendant. An attribute or a run
 * of loose text has no element of its own and says which it is instead, which
 * is itself the answer: neither is ever a listing.
 */
function label(unit: TranslationUnit): string {
  const element = unit.element ?? unit.kind;
  return unit.className === undefined ? element : `${element}.${unit.className}`;
}

/** The block, whole, on one line: a listing's own newlines break the format. */
function shown(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildCodePrompt(batch: CodeBatch, retryReason?: string): string {
  const lines = [`#CODEINDEX v1 batch=${batch.index}/${batch.total} count=${batch.units.length}`];
  if (retryReason !== undefined) lines.push("@retry", shown(retryReason));
  lines.push(
    "",
    "You are translating this book. For each line, decide what a translator",
    "would do with it: TRANSLATE it, or KEEP it exactly as it is.",
    "",
    "Keep a line when a translator would retype it verbatim: source code, a",
    "command, console output, a path, an identifier, configuration.",
    "",
    "Translate everything a reader reads as prose — including sentences that",
    "discuss code and are thick with technical terms. `In the previous",
    "snippet, AuthModule imports UsersModule` is a sentence a translator",
    "translates; `imports: [UsersModule]` is one they retype. The question is",
    "not whether the line is ABOUT programming: it is whether it would run.",
    "",
    "Judge the whole line, never the parts inside it. A sentence stays prose",
    "when it names identifiers, quotes a flag or carries a URL: those are",
    "pieces of it, not what it is. Answer keep only when the ENTIRE line is",
    "something they would retype unchanged.",
    "",
    "Reply with one verdict per id, same ids, same order.",
    "",
    "Reply ONLY in this exact format:",
    `#CODEVERDICT v1 batch=${batch.index}/${batch.total} count=${batch.units.length}`,
    "[1] <translate|keep>",
    "@end",
    "",
  );
  batch.units.forEach((unit, at) => {
    lines.push(`[${at + 1}] ${label(unit).padEnd(18)} ${shown(unit.source)}`);
  });
  lines.push("@end");
  return lines.join("\n");
}
```

e, nello stesso file, il parsing — dove ogni rifiuto porta un motivo in parole, perché è quel motivo che il tentativo successivo rimette nel prompt:

```typescript
const HEADER = /^#CODEVERDICT\s+v1\s+batch=(\d+)\/(\d+)\s+count=(\d+)\s*$/;

/**
 * `keep` means a translator would retype this line unchanged — it is code.
 * `translate` means they would translate it — it is prose.
 *
 * The words are the translator's, not a classifier's, because that is the
 * decision actually being delegated. The older `code|prose` spelling is still
 * accepted: a model answering in the previous vocabulary is out of date, not
 * wrong.
 */
const VERDICT = /^\[(\d+)\]\s+(translate|keep|code|prose)\s*$/;

export function parseCodeVerdict(
  raw: string,
  batch: CodeBatch,
): { ok: true; code: Set<string>; prose: Set<string> } | { ok: false; reason: string } {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADER.test(line.trim()));
  if (start === -1) return { ok: false, reason: "header #CODEVERDICT not found" };

  const header = HEADER.exec(lines[start]!.trim())!;
  const index = Number(header[1]);
  const total = Number(header[2]);
  const count = Number(header[3]);
  if (index !== batch.index || total !== batch.total) {
    return { ok: false, reason: `expected batch ${batch.index}/${batch.total}, found ${index}/${total}` };
  }
  if (count !== batch.units.length) {
    return { ok: false, reason: `expected count ${batch.units.length}, found ${count}` };
  }

  // Searched from the header onward, never from the top: the terminator is the
  // one that closes THIS block, and a block whose text contains the word would
  // otherwise end the parsing before it began.
  const end = lines.findIndex((line, at) => at > start && line.trim() === "@end");
  if (end === -1) return { ok: false, reason: "terminator @end not found" };

  const code = new Set<string>();
  const prose = new Set<string>();
  let expected = 1;

  for (const line of lines.slice(start + 1, end).map((line) => line.trim())) {
    if (line === "") continue;
    const matched = VERDICT.exec(line);
    if (matched === null) return { ok: false, reason: `malformed verdict: ${line}` };

    const local = Number(matched[1]);
    if (local !== expected) return { ok: false, reason: `expected id ${expected}, found ${local}` };

    const unit = batch.units[local - 1];
    if (unit === undefined) return { ok: false, reason: `verdict for unknown id ${local}` };
    (matched[2] === "keep" || matched[2] === "code" ? code : prose).add(unit.id);
    expected++;
  }

  if (expected - 1 !== batch.units.length) {
    return { ok: false, reason: `expected ${batch.units.length} verdicts, found ${expected - 1}` };
  }
  return { ok: true, code, prose };
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx vitest run core/test/code-wire.test.ts`
Atteso: PASS.

- [ ] **Step 5: Scrivi il test del ciclo, e fallo fallire**

In coda a `core/test/code.test.ts`:

```typescript
/**
 * Sequential, this pass is the longest thing in a run and the reason the bar
 * looked hung. The batches are independent — none reads what another decided —
 * so they go out as wide as the run allows.
 */
it("judges the batches in parallel", async () => {
  let running = 0;
  let highest = 0;
  const units = Array.from({ length: 6 }, (_, at) => unit(`c1.xhtml#${at}`, "translate", "text"));

  await indexCodeBlocks({
    units,
    backend: {
      call: async () => {
        running++;
        highest = Math.max(highest, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return {
          text: "#CODEVERDICT v1 batch=1/3 count=2\n[1] translate\n[2] translate\n@end",
          tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
        };
      },
    },
    sourceHash: "h",
    batchSize: 2,
    concurrency: 3,
  });

  expect(highest).toBeGreaterThan(1);
});

/**
 * An abstention never changes a deterministic state, and it is still counted.
 * That rule is babelBook's and it does not change here.
 */
it("abstains without moving anything when the format never comes back", async () => {
  const units = [unit("c1.xhtml#1", "translate", "text")];
  const index = await indexCodeBlocks({
    units,
    backend: { call: async () => ({
      text: "sorry", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
    }) },
    sourceHash: "h",
  });

  expect(index).toMatchObject({ marked: [], freed: [], abstained: 1 });
});
```

Nota: l'intestazione della risposta finta dichiara `batch=1/3`, quindi solo il primo batch la accetta e gli altri due si astengono — è voluto, il test misura la concorrenza, non i verdetti.

Run: `npx vitest run core/test/code.test.ts`
Atteso: FAIL — `concurrency` non è una proprietà nota e il ciclo è sequenziale.

- [ ] **Step 6: Riscrivi il ciclo**

In `core/analyze/code.ts`: togli `buildPrompt`, `parseVerdicts` e `VERDICT`, importa il trasporto nuovo, porta i tentativi a tre, e conserva il motivo del rifiuto fra un tentativo e l'altro:

```typescript
const ATTEMPTS = 3;

export interface IndexInput {
  units: TranslationUnit[];
  backend: LlmBackend;
  sourceHash: string;
  batchSize?: number;
  /** Batches are independent, so they go out as wide as the run allows. */
  concurrency?: number;
  progress?: ProgressSink;
  signal?: AbortSignal;
}
```

Il giudizio di un batch:

```typescript
  const judge = async (batch: CodeBatch): Promise<void> => {
    let retryReason: string | undefined;

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      input.signal?.throwIfAborted();
      const result = await input.backend.call({
        prompt: buildCodePrompt(batch, retryReason),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      const verdict = parseCodeVerdict(result.text, batch);
      if (!verdict.ok) {
        // Carried into the next attempt. A model told what was wrong with its
        // last answer fixes it; a model asked again, identically, answers
        // identically, and the batch burns its whole budget saying so.
        retryReason = verdict.reason;
        continue;
      }

      for (const unit of batch.units) {
        if (unit.state === "translate" && verdict.code.has(unit.id)) marked.push(unit.id);
        if (unit.state === "code" && verdict.prose.has(unit.id)) freed.push(unit.id);
      }
      return;
    }

    abstained++;
  };
```

e i batch percorsi a ondate, riferendo il progresso dopo ognuno:

```typescript
  const batches = batchUnits(questionable, batchSize);
  const width = Math.max(1, input.concurrency ?? 2);
  let judged = 0;

  for (let at = 0; at < batches.length; at += width) {
    input.signal?.throwIfAborted();
    await Promise.all(batches.slice(at, at + width).map(async (batch) => {
      await judge(batch);
      judged++;
      input.progress?.report({ phase: "code-index", done: judged, total: batches.length });
    }));
  }

  // Sorted before they leave. The batches finish in whatever order the network
  // returns them, and this list becomes a checkpoint: an order that changes
  // between two identical runs would make the record of one unreadable against
  // the other.
  marked.sort();
  freed.sort();
```

`marked`, `freed` e `abstained` sono scritti da più giudizi concorrenti; il ciclo di eventi è a turno singolo e ogni scrittura è sincrona fra un `await` e l'altro, quindi né `push` né `++` si perdono.

Le tre regole di babelBook restano intatte: un'astensione non muove niente, ciò che il markup dichiara non si libera (solo `css-code-surface`), e un sospetto diventa `maybe-code` e va comunque al traduttore.

- [ ] **Step 7: Esegui i test e verifica che passino**

Run: `npx vitest run core/test/code.test.ts core/test/code-wire.test.ts && npm test && npm run typecheck`
Atteso: PASS.

- [ ] **Step 8: Commetti**

```bash
git add core/analyze core/test
git commit -m "feat(code-index): la domanda del traduttore, l'etichetta, e i batch in parallelo"
```

---

### Task 9: La versione del passaggio, sotto una chiave sua

Cambiare il prompt senza versionarlo farebbe riusare un indice prodotto dalla domanda sbagliata: il difetto sopravviverebbe alla propria correzione. Ma la versione **non** entra nella chiave condivisa, o correggere una domanda sul codice butterebbe via anche le traduzioni, che quella domanda non ha prodotto.

**Files:**
- Modify: `core/translate/versions.ts`
- Create: `app/main/run/code-index-key.ts`, `app/test/code-index-key.test.ts`
- Modify: `app/main/run/orchestrator.ts`
- Test: `core/test/versions.test.ts`

**Interfaces:**
- Produces: `CODE_INDEX_VERSION` in `core/translate/versions.ts`; `function codeIndexKey(cacheKey: string, version?: number): string`

- [ ] **Step 1: Scrivi il test che fallisce**

`app/test/code-index-key.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CODE_INDEX_VERSION } from "../../core/translate/versions.ts";
import { codeIndexKey } from "../main/run/code-index-key.ts";

/**
 * A key of its own, derived from the run's.
 *
 * The code index is a different piece of work from the translation: it was
 * produced by a different prompt and answers a different question. Putting its
 * version in the shared key would throw away a translated book every time a
 * question about code is corrected — paying twice for something that has not
 * changed.
 */
describe("the code index key", () => {
  it("changes when the run's key changes", () => {
    expect(codeIndexKey("a")).not.toBe(codeIndexKey("b"));
  });

  it("changes when the version changes, and the run's key does not", () => {
    expect(codeIndexKey("a", CODE_INDEX_VERSION)).not.toBe(codeIndexKey("a", CODE_INDEX_VERSION + 1));
  });

  it("is the same key twice for the same inputs", () => {
    expect(codeIndexKey("a")).toBe(codeIndexKey("a"));
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/code-index-key.test.ts`
Atteso: FAIL — nessuno dei due moduli esporta ciò che serve.

- [ ] **Step 3: Scrivi la versione e la chiave**

In `core/translate/versions.ts`, accanto alle altre e col loro stesso patto:

```typescript
/**
 * 2: the pass asks the translator's question — would you translate this line
 * or retype it — instead of a classifier's, judges the whole line, carries the
 * element and class beside the text, and flattens each block onto one line.
 * Under version 1, measured on a real book by the prototype this came from,
 * the model called 432 blocks code, at least 86 of them plain prose.
 *
 * It does NOT go into `cacheKey`. The code index is keyed separately, because
 * a translation was not produced by this question and must not be thrown away
 * when this question is corrected.
 */
export const CODE_INDEX_VERSION = 2;
```

`app/main/run/code-index-key.ts`:

```typescript
import { createHash } from "node:crypto";
import { CODE_INDEX_VERSION } from "../../../core/translate/versions.ts";

/**
 * The key the code index is kept under: the run's key, plus this pass's own
 * version.
 *
 * `project_phase_result` already keys a checkpoint per phase, so raising the
 * version throws away the index and nothing else — which is the whole point of
 * not putting it in the shared key.
 */
export function codeIndexKey(cacheKey: string, version: number = CODE_INDEX_VERSION): string {
  return createHash("sha256").update(`code-index ${version} ${cacheKey}`).digest("hex");
}
```

In `app/main/run/orchestrator.ts`, nella fase del code-index, usa la chiave derivata nei tre punti che oggi passano `config.cacheKey`: `store.codeIndex(...)`, `sourceHash` di `indexCodeBlocks`, e quindi `commitCodeIndex`, che scrive il checkpoint sotto `index.sourceHash`.

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx vitest run app/test/code-index-key.test.ts core/test/versions.test.ts app/test/orchestrator.test.ts && npm run typecheck`
Atteso: PASS.

- [ ] **Step 5: Commetti**

```bash
git add core/translate/versions.ts app/main/run/code-index-key.ts app/test core/test
git commit -m "feat(code-index): una versione propria, sotto una chiave propria"
```

---

### Task 10: Il ragionamento si sceglie per modello

Oggi esiste un solo caso cablato — `routeDefaults("deepseek")` — e il commento sopra spiega perché non è una preferenza: il ragionamento acceso brucia il budget di output, il chunk torna vuoto con `finishReason: "length"`, ogni unità cade in fallback, e la chiamata è fatturata piena. Quel fatto vale per ogni modello che ragiona.

**Files:**
- Create: `app/main/db/migrations/011-model-reasoning.sql`
- Modify: `app/main/providers/store.ts`, `app/main/run/runtime.ts`, `app/main/run/cache-key.ts`, `app/main/ipc.ts`
- Modify: `app/shared/channels.ts`, `app/shared/dto.ts`, `core/translate/versions.ts`
- Test: `app/test/providers.test.ts`, `app/test/cache-key.test.ts`, `app/test/schema.test.ts`

**Interfaces:**
- Produces: colonna `provider_model.reasoning_enabled INTEGER`; `function routeReasoning(route: string, enabled: boolean): Record<string, unknown>`; `function reasoningOf(db, providerId, modelId): boolean`; `function setReasoning(db, providerId, modelId, enabled: boolean | null): void`; canale `provider.setReasoning`; `ProviderModel.reasoningEnabled: boolean | null`; `CacheKeyInput.reasoning: boolean`

- [ ] **Step 1: Scrivi il test che fallisce**

In coda a `app/test/providers.test.ts`:

```typescript
/**
 * Facts about how this application must call a route, not about what the route
 * serves — the same reason `routeDefaults` lives here and not in a catalogue.
 * Each route spells the same idea differently, and this is the one place that
 * knows how.
 */
describe("the reasoning options of a route", () => {
  it("turns it off in the words each route uses", () => {
    expect(routeReasoning("anthropic", false)).toMatchObject({ anthropic: { thinking: { type: "disabled" } } });
    expect(routeReasoning("deepseek", false)).toMatchObject({ deepseek: { thinking: { type: "disabled" } } });
    expect(routeReasoning("openai", false)).toMatchObject({ openai: { reasoningEffort: "minimal" } });
    expect(routeReasoning("google", false))
      .toMatchObject({ google: { thinkingConfig: { thinkingBudget: 0 } } });
  });

  /**
   * On, the route is left to its own default. Naming a budget this application
   * has no way to choose would be inventing one, the same refusal as an
   * invented price or an invented endpoint.
   */
  it("says nothing at all when it is on", () => {
    expect(routeReasoning("anthropic", true)).toEqual({});
  });

  it("says nothing for a route it does not know", () => {
    expect(routeReasoning("acme", false)).toEqual({});
  });
});

describe("the reasoning of a model", () => {
  /**
   * Off, until someone says otherwise. Translation gains nothing from
   * reasoning and loses the output budget to it: the chunk comes back empty
   * with `finishReason: "length"`, every unit in it falls back to the source,
   * and the call is billed in full.
   */
  it("is off when nothing was chosen", () => {
    const d = db();
    const provider = createProvider(d, crypto, { ...acme, apiKey: "k" });
    expect(reasoningOf(d, provider.id, "m1")).toBe(false);
  });

  it("is what was chosen once something was", () => {
    const d = db();
    const provider = createProvider(d, crypto, { ...acme, apiKey: "k" });
    setReasoning(d, provider.id, "m1", true);
    expect(reasoningOf(d, provider.id, "m1")).toBe(true);
  });

  /** Null is not false: "not chosen" and "chosen off" are different facts. */
  it("goes back to unchosen, and reads as off", () => {
    const d = db();
    const provider = createProvider(d, crypto, { ...acme, apiKey: "k" });
    setReasoning(d, provider.id, "m1", true);
    setReasoning(d, provider.id, "m1", null);

    expect(reasoningOf(d, provider.id, "m1")).toBe(false);
    expect(listProviders(d)[0]!.models[0]!.reasoningEnabled).toBeNull();
  });
});
```

`db()`, `crypto`, `acme` e `createProvider` sono gli helper e gli import già in testa a `app/test/providers.test.ts`.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/providers.test.ts`
Atteso: FAIL — nessuna delle tre funzioni esiste.

- [ ] **Step 3: Migrazione e mappatura**

`app/main/db/migrations/011-model-reasoning.sql`:

```sql
-- Whether this model should reason, for this application's purposes.
--
-- Null means "whatever the route does by default", which is what routeDefaults
-- did for DeepSeek alone. Translation gains nothing from reasoning and loses
-- the output budget to it, so the application's own default is off — but the
-- column stays nullable, because "not chosen" and "chosen off" are different
-- facts and only one of them is the user's.
ALTER TABLE provider_model ADD COLUMN reasoning_enabled INTEGER;
```

In `app/main/providers/store.ts`, accanto a `routeDefaults`:

```typescript
/**
 * How each route spells "do not think about it".
 *
 * The idea is one and the words are four, so the translation table lives in a
 * single place — the same reason `routeDefaults` is here. On, nothing is said:
 * a budget this application picked would be a number nobody measured.
 */
export function routeReasoning(route: string, enabled: boolean): Record<string, unknown> {
  if (enabled) return {};
  if (route === "anthropic") return { anthropic: { thinking: { type: "disabled" } } };
  if (route === "deepseek") return { deepseek: { thinking: { type: "disabled" } } };
  if (route === "openai") return { openai: { reasoningEffort: "minimal" } };
  if (route === "google") return { google: { thinkingConfig: { thinkingBudget: 0 } } };
  return {};
}
```

più `reasoningOf` (legge `reasoning_enabled`, `null` → `false`) e `setReasoning`. `routeDefaults` perde il caso DeepSeek, che ora è un caso come gli altri di `routeReasoning`, e il suo commento si sposta lì.

In `app/main/run/runtime.ts`, dove si costruisce il `BackendSpec`, componi le opzioni: `{ ...routeDefaults(route), ...routeReasoning(route, reasoningOf(db, providerId, modelId)) }`.

In `core/translate/versions.ts`, `CacheKeyInput` guadagna:

```typescript
  /**
   * Whether the model was asked to reason, resolved — the route's default
   * already applied.
   *
   * Resolved rather than as chosen, so two configurations that call the model
   * the same way produce the same key even when one says it and the other
   * leaves it implied.
   */
  reasoning: boolean;
```

e `canonical` guadagna `reasoning: input.reasoning`. In `app/main/run/cache-key.ts`, `projectCacheKey` prende `reasoning` fra i suoi argomenti e lo passa: è già l'unico posto che sa dove stanno in tabella le parti della chiave.

In `app/shared/dto.ts`, `ProviderModel` guadagna `reasoningEnabled: boolean | null`, letto dalla colonna; in `app/shared/channels.ts` il canale `provider.setReasoning` con `req: { providerId: string; modelId: string; enabled: boolean | null }` e `res: void`, aggiunto anche alla lista `INVOCATIONS`; in `app/main/ipc.ts` il gestore che chiama `setReasoning` e trasmette `providers.changed`.

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm test && npm run typecheck`
Atteso: PASS. `app/test/cache-key.test.ts` va esteso con un caso che verifica che due `reasoning` diversi diano chiavi diverse; aggiorna il numero di migrazioni in `app/test/schema.test.ts`.

- [ ] **Step 5: Commetti**

```bash
git add app/main app/shared core/translate/versions.ts app/test
git commit -m "feat(providers): il ragionamento e' una scelta del modello, non una riga cablata"
```

---

### Task 11: L'interruttore e il nome, nella schermata

**Files:**
- Modify: `app/renderer/src/app/settings/providers.html`, `providers.ts`
- Modify: `app/locales/en.json`, `app/locales/it.json`
- Test: `app/renderer/src/app/settings/providers.spec.ts`

**Interfaces:**
- Consumes: `provider.setReasoning` e `ProviderModel.reasoningEnabled` dal Task 10

- [ ] **Step 1: Scrivi i test che falliscono**

In coda a `app/renderer/src/app/settings/providers.spec.ts`:

```typescript
/**
 * A switch on a model that cannot reason is a control that does nothing, and a
 * control that does nothing teaches people not to trust the others.
 */
/** A model the catalogue says can reason, beside the one that cannot. */
const thinker: ProviderModel = {
  ...priced, id: "acme-max", displayName: "Acme Max", reasoningEnabled: null,
  capabilities: { toolCall: true, reasoning: true, structuredOutput: true, attachment: false },
};

it("offers the reasoning switch only for a model that can reason", async () => {
  const { fixture } = mount(bridge({
    "providers.list": [{ ...saved, models: [thinker, { ...priced, reasoningEnabled: null }] }],
  }));
  await fixture.whenStable();
  fixture.detectChanges();

  // The switch follows the model chosen in the card's select, which starts on
  // the first — the one that reasons.
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

  fixture.nativeElement.querySelector("[data-testid=reasoning-p1]").click();
  await fixture.whenStable();

  expect(calls(invoke, "ui.confirm")).toHaveLength(1);
  expect(calls(invoke, "provider.setReasoning")).toHaveLength(0);
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
```

`bridge`, `mount`, `calls`, `priced`, `saved` ed `entry` sono gli helper e le costanti in testa a `app/renderer/src/app/settings/providers.spec.ts`; `entry` è la voce di catalogo con id `acme`.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npm run test:ui -w app`
Atteso: FAIL — l'interruttore non esiste e il campo del nome è nascosto per le voci di catalogo.

- [ ] **Step 3: L'interruttore**

In `app/renderer/src/app/settings/providers.html`, dentro `.provider__actions`, dopo il `<select>` del modello:

```html
                @if (canReason(provider); as chosen) {
                  <label class="label cursor-pointer gap-2">
                    <input
                      class="toggle toggle-sm"
                      type="checkbox"
                      [attr.data-testid]="'reasoning-' + provider.id"
                      [ngModel]="reasoningOf(provider)"
                      [ngModelOptions]="{ standalone: true }"
                      (ngModelChange)="setReasoning(provider, $event)" />
                    <span>{{ t('providers.reasoning') }}</span>
                  </label>
                }
```

In `providers.ts`, `canReason(provider)` restituisce il `ProviderModel` scelto in `modelFor(provider)` quando `capabilities?.reasoning === true`, altrimenti `null`; `reasoningOf` legge `reasoningEnabled ?? false`; `setReasoning` chiede prima `ui.confirm` col genere `reasoningChange` e solo su conferma invoca `provider.setReasoning` e ricarica l'elenco. Aggiungi `reasoningChange` a `CONFIRM_KINDS` in `app/shared/channels.ts` e la sua frase al catalogo delle conferme nel main.

Stringhe nuove in entrambi i locali: `providers.reasoning`, e la coppia titolo/corpo della conferma, che dice cosa verrebbe disfatto.

- [ ] **Step 4: Il nome**

La condizione a `providers.html:158` sparisce: il campo del nome si mostra sempre. L'intestazione del modulo a `providers.html:154`, che mostrava `form.name`, mostra il nome della **voce di catalogo** — l'identità di ciò che stai collegando — mentre il campo porta il nome che gli dai tu. In `providers.ts`, la `Draft` costruita da una voce di catalogo tiene il nome del catalogo come valore iniziale e guadagna il campo per l'etichetta immutabile dell'intestazione.

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `npm run test:ui -w app && npm run typecheck && npm test`
Atteso: PASS.

- [ ] **Step 6: Commetti**

```bash
git add app/renderer app/shared app/main app/locales
git commit -m "feat(providers): un nome che lo distingue, e il ragionamento che si spegne"
```

---

## Chiusura

- [ ] **Aggiorna `docs/superpowers/STATO.md`**: la tabella dei piani, il numero dei test, e le voci di «Cosa nessuna suite dimostra» che questo lavoro chiude o sposta — il code-index sequenziale non c'è più, i token di una corsa fermata a un gate non sono più zero.
- [ ] **Scrivi in testa a questo piano** cosa l'esecuzione ha cambiato rispetto a quanto scritto qui, come fanno gli altri piani: dove piani e codice divergono, vince il codice.
- [ ] **La prova che nessuna suite può dare**: un libro vero con un provider vero, guardando la barra della fase muoversi durante il code-index e il conteggio dei token salire prima del primo chunk tradotto.

## Cosa questo piano non fa

Dalla spec, dichiarati e lasciati fuori: l'ordine dei gruppi nelle Esclusioni oltre la spezzatura per documento; il costo per fase nel report, che resta un totale; l'attributo traducibile su un elemento di blocco (`<p title="…">`), limite noto del piano 1.
