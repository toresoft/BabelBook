# babelBook — Piano 2: il layer di traduzione del core

**Stato: completo** — 14 task su 14, al 2026-08-25. Il codice vive in
`core/translate/`, `core/analyze/`, `core/glossary/` e `core/ports.ts`.
Cinque cose sono state decise diversamente da come le descrive questo piano:
il campo `interleaved` nel contesto, `verifyDeclared` sulla lingua, `none-applies`
nel voto sul dominio, la terza regola terminologica `prefer`, e il fatto che il
troncamento non spezza un gruppo perché il ritentativo lo fa da sé.
Le ragioni stanno nei messaggi di commit.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** costruire la metà del core che parla con un modello — porte, glossari, analisi, protocollo, validazione, motore — senza nominare nessun provider e senza toccare né database né interfaccia.

**Architecture:** il core dichiara di cosa ha bisogno (`ProjectStore`, `LlmBackend`, `ProgressSink`) e riceve le implementazioni da chi lo ospita. Ogni risposta del modello attraversa cinque livelli di validazione; un ritentativo conserva le righe valide e rimanda solo le unità rifiutate con la diagnosi. Tutte le fasi sono funzioni pure rispetto alle porte, quindi si testano con un backend finto e uno store in memoria.

**Tech Stack:** TypeScript su Node 24.18.x, ESM, vitest. Nessuna dipendenza nuova.

**Spec:** `docs/superpowers/specs/2026-08-24-babelbook-design.md`
**Piano precedente:** `docs/superpowers/plans/2026-08-24-babelbook-core-epub.md`

## Global Constraints

Valgono le stesse del piano 1, che qui si ripetono perché chi esegue questo piano può non aver letto quello.

- **Node 24.18.x**, da esportare nelle shell non interattive:
  `export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`
- **ESM**, `"type": "module"`, **import con estensione `.ts`**, **solo sintassi cancellabile** (niente `enum`, `namespace`, parameter properties).
- **`core/` non importa Electron, `node:sqlite`, né alcun pacchetto di provider.** Il test di confine del piano 1 lo fa rispettare, e questo piano gli aggiunge una regola: né `core/translate/` né `core/analyze/` possono **nominare un modello concreto** (`claude-`, `gpt-`, `deepseek-`, `gemini-`).
- **Codice, commenti e messaggi di errore in inglese.** I documenti in italiano.
- **Il core non produce testo rivolto all'utente**: codici stabili, mai frasi.
- **Test:** `npm test -w core`. Un file solo: `npx vitest run core/test/<file>.test.ts`.
- **Nessuna chiamata di rete nei test.** Il backend è sempre finto.
- **Commit a ogni task.**

## Fatti accertati eseguendo il piano 1

Non sono opinioni: sono stati misurati, e alcuni contraddicono quello che il piano 1 scriveva.

- **Semantica delle posizioni di `saxes`, misurata.** Il testo finisce a `position - 1`, tranne a fine documento dove nessun `<` è stato consumato; un **commento è riportato un carattere prima**, fermo sul proprio `>` (`rawEnd = position + 1`); CDATA, istruzioni di elaborazione e tag finiscono esattamente a `position`.
- **Gli href del manifest sono URL, non percorsi.** Si risolvono solo con `resolveHref(base, href)`, che restituisce `{ path, fragment }` e decodifica il percent-encoding con tolleranza. Leggere un href come nome di file perde interi capitoli in silenzio: è successo su un libro vero.
- **Esiste uno stato che il piano 1 non enumerava**: un blocco foglia che contiene un commento, CDATA o un'istruzione di elaborazione diventa `uncomposable` con `reason: "unsupported-content"`.
- **`extract` forma una sequenza di testo nudo solo dentro un contenitore di blocco.** Una sequenza formata dentro `html` inghiottirebbe `<head>`, e il titolo del documento è metadato.
- **`writeEpub` usa un mtime fisso**, così entry identiche producono byte identici.
- **Un attributo traducibile sull'elemento di blocco stesso** (`<p title="…">`) oggi **non** viene tradotto: le unità attributo nascono solo dai segnaposto inline. È un limite noto del piano 1, non una scelta.

## Struttura dei file

```
core/
  ports.ts                   ProjectStore, LlmBackend, ProgressSink
  translate/
    types.ts                 ChunkContext, TermEntry, TranslationRequest
    versions.ts              PROMPT_VERSION, CONTEXT_VERSION, cacheKey
    instructions.ts          costruzione del prompt di traduzione
    wire.ts                  formato della richiesta e lettura della risposta
    validate.ts              i cinque livelli
    plan.ts                  raggruppamento delle unità e finestra di contesto
    terms.ts                 iniezione dei termini e misura dell'aderenza
    engine.ts                un gruppo dall'invio alla conferma, con ritentativi
  glossary/
    parse.ts                 markdown con frontmatter → Glossary
    index.ts                 caricamento, identità, filtro per lingua
  analyze/
    sample.ts                campionamento di blocchi indipendenti
    language.ts              identificazione della lingua
    domain.ts                voto a maggioranza sul glossario applicabile
    candidates.ts            estrazione dei termini candidati
    code.ts                  indice del codice: marcare e liberare
  test/
    fake/backend.ts          LlmBackend finto, programmabile
    fake/store.ts            ProjectStore in memoria
    *.test.ts
```

---

### Task 1: Le porte

**Files:**
- Create: `core/ports.ts`, `core/test/fake/store.ts`, `core/test/fake/backend.ts`, `core/test/ports.test.ts`

**Interfaces:**
- Consumes: `TranslationUnit`, `UnitState` (piano 1)
- Produces:

```ts
export interface StoredTranslation {
  unitId: string;
  text: string;
  cacheKey: string;
  attempts: number;
  outcome: "translated" | "fell-back" | "identical";
}

export interface RunEvent {
  code: string;                    // "unit-fell-back", "chunk-exhausted", "abstained"
  severity: "info" | "warning" | "degradation";
  payload: Record<string, unknown>;
}

export interface ProjectStore {
  units(filter?: { states?: UnitState[]; doc?: string }): Promise<TranslationUnit[]>;
  putUnitState(unitId: string, state: UnitState, reason?: string): Promise<void>;
  translations(cacheKey: string): Promise<Map<string, StoredTranslation>>;
  putTranslation(t: StoredTranslation): Promise<void>;
  terms(): Promise<TermEntry[]>;
  putTerms(terms: TermEntry[]): Promise<void>;
  event(e: RunEvent): Promise<void>;
}

export interface LlmCall {
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: "stop" | "length" | "other";
}

export interface LlmBackend {
  call(input: LlmCall): Promise<LlmResult>;
}

export interface Progress {
  phase: "analyze" | "candidates" | "code-index" | "translate" | "compose";
  done: number;
  total: number;
  unitId?: string;
}

export interface ProgressSink {
  report(p: Progress): void;
}
```

- [ ] **Step 1: Scrivere il test che fallisce**

`core/test/ports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake/store.ts";
import { FakeBackend } from "./fake/backend.ts";

describe("fakes", () => {
  it("stores and returns a translation under its cache key", async () => {
    const store = new FakeStore();
    await store.putTranslation({
      unitId: "c1.xhtml#1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated",
    });
    expect((await store.translations("k1")).get("c1.xhtml#1")?.text).toBe("Uno");
    expect((await store.translations("k2")).size).toBe(0);
  });

  it("replays scripted answers and records what it was asked", async () => {
    const backend = new FakeBackend(["first", "second"]);
    expect((await backend.call({ prompt: "a" })).text).toBe("first");
    expect((await backend.call({ prompt: "b" })).text).toBe("second");
    expect(backend.prompts).toEqual(["a", "b"]);
  });

  it("refuses to answer more times than it was scripted", async () => {
    const backend = new FakeBackend(["only"]);
    await backend.call({ prompt: "a" });
    await expect(backend.call({ prompt: "b" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

Run: `npx vitest run core/test/ports.test.ts`
Atteso: FAIL, `Cannot find module './fake/store.ts'`.

- [ ] **Step 3: Scrivere porte e finti**

`core/ports.ts` contiene solo tipi e interfacce: nessuna implementazione, nessun import se non i tipi del layer EPUB.

`FakeStore` tiene tutto in `Map`. `FakeBackend` prende un elenco di risposte, le restituisce in ordine, registra i prompt ricevuti in `prompts`, e **lancia quando le risposte finiscono**: un finto che risponde all'infinito nasconde i cicli di ritentativo fuori controllo, che sono esattamente ciò che i test devono poter vedere.

`FakeBackend` accetta anche una funzione al posto dell'elenco, per i test che devono rispondere in base al prompt ricevuto: `new FakeBackend((call) => ({ text: ..., tokensIn: 0, tokensOut: 0, finishReason: "stop" }))`.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/ports.test.ts`
Atteso: PASS, tre test.

- [ ] **Step 5: Commit**

```bash
git add core/ports.ts core/test/fake core/test/ports.test.ts
git commit -m "feat(core): declare what the engine needs from its host, and fake it"
```

---

### Task 2: Versioni e chiave di cache

**Files:**
- Create: `core/translate/versions.ts`, `core/test/versions.test.ts`

**Interfaces:**
- Consumes: niente
- Produces:

```ts
export const PROMPT_VERSION: number;    // parte da 1
export const CONTEXT_VERSION: number;   // parte da 1
export interface CacheKeyInput {
  modelId: string;                      // la specifica scritta, verbatim
  sourceLanguage: string;
  targetLanguage: string;
  glossaries: string[];                 // "nome@versione", non ordinati in ingresso
}
export function cacheKey(input: CacheKeyInput): string;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/versions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cacheKey } from "../translate/versions.ts";

const base = { modelId: "acme:m1", sourceLanguage: "en", targetLanguage: "it", glossaries: ["fantasy@2"] };

describe("cacheKey", () => {
  it("does not depend on the order the glossaries arrive in", () => {
    const a = cacheKey({ ...base, glossaries: ["fantasy@2", "tech@1"] });
    const b = cacheKey({ ...base, glossaries: ["tech@1", "fantasy@2"] });
    expect(a).toBe(b);
  });

  it("changes when a glossary version changes", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, glossaries: ["fantasy@3"] }));
  });

  it("changes when the model changes", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, modelId: "acme:m2" }));
  });

  it("changes when the target language changes", () => {
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, targetLanguage: "fr" }));
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/versions.test.ts`
Atteso: FAIL, `Cannot find module '../translate/versions.ts'`.

- [ ] **Step 3: Implementare**

La chiave è lo sha256 di una stringa canonica che concatena, con un separatore che non può comparire nei componenti: `PROMPT_VERSION`, `CONTEXT_VERSION`, `modelId`, le due lingue e l'**identità ordinata** dei glossari attivi.

**Perché le versioni sono a mano.** Cambiare le istruzioni, la strategia di finestra o l'identità di un glossario cambia il contratto sotto cui una traduzione è stata prodotta. Se la chiave non cambiasse, una ripresa riuserebbe in silenzio traduzioni fatte sotto un contratto diverso — e nessuno se ne accorgerebbe leggendo il libro. Chi modifica `instructions.ts` alza `PROMPT_VERSION` nello stesso commit.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/versions.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add core/translate/versions.ts core/test/versions.test.ts
git commit -m "feat(translate): a cache key that cannot silently reuse another contract's work"
```

---

### Task 3: Il glossario

**Files:**
- Create: `core/glossary/parse.ts`, `core/glossary/index.ts`, `core/test/glossary.test.ts`

**Interfaces:**
- Consumes: niente
- Produces:

```ts
export interface TermEntry {
  source: string;
  target?: string;                 // assente per una regola "dnt"
  rule: "dnt" | "must";
  note?: string;
  origin: "glossary" | "extracted" | "manual";
}
export interface Glossary {
  name: string;
  version: number;
  description: string;             // la legge il voto di dominio
  sourceLanguage: string;
  targetLanguage: string;
  terms: TermEntry[];
}
export class GlossaryError extends Error { code: string }
export function parseGlossary(markdown: string): Glossary;
export function serializeGlossary(g: Glossary): string;
export function glossaryIdentity(gs: Glossary[]): string[];        // ["nome@versione", ...] ordinati
export function supportsLanguages(g: Glossary, from: string, to: string): boolean;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/glossary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { glossaryIdentity, parseGlossary, serializeGlossary, supportsLanguages } from "../glossary/index.ts";

const source = `---
name: fantasy
version: 2
description: Epic fantasy with invented names and places
sourceLanguage: en
targetLanguage: it
---

| source | target | rule | note |
|---|---|---|---|
| Rivendell |  | dnt | place name |
| dwarf | nano | must | never "nanetto" |
`;

describe("parseGlossary", () => {
  it("reads the frontmatter and the term table", () => {
    const g = parseGlossary(source);
    expect(g.name).toBe("fantasy");
    expect(g.version).toBe(2);
    expect(g.terms).toEqual([
      { source: "Rivendell", target: undefined, rule: "dnt", note: "place name", origin: "glossary" },
      { source: "dwarf", target: "nano", rule: "must", note: `never "nanetto"`, origin: "glossary" },
    ]);
  });

  it("round-trips through serialize", () => {
    expect(parseGlossary(serializeGlossary(parseGlossary(source)))).toEqual(parseGlossary(source));
  });

  it("refuses a term table row whose rule it does not know", () => {
    const bad = source.replace("| dnt |", "| maybe |");
    expect(() => parseGlossary(bad)).toThrow(/UNKNOWN_RULE|unknown rule/i);
  });

  it("refuses a glossary without a version", () => {
    const bad = source.replace("version: 2\n", "");
    expect(() => parseGlossary(bad)).toThrow();
  });
});

describe("identity", () => {
  it("sorts, so the same set always reads the same", () => {
    const g = parseGlossary(source);
    expect(glossaryIdentity([{ ...g, name: "tech", version: 1 }, g])).toEqual(["fantasy@2", "tech@1"]);
  });

  it("matches languages by primary subtag", () => {
    const g = parseGlossary(source);
    expect(supportsLanguages(g, "en-US", "it")).toBe(true);
    expect(supportsLanguages(g, "fr", "it")).toBe(false);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/glossary.test.ts`
Atteso: FAIL, `Cannot find module '../glossary/index.ts'`.

- [ ] **Step 3: Implementare**

1. Il formato è markdown con frontmatter YAML minimale — solo coppie `chiave: valore`, nessuna libreria: il file è scritto a mano da chi cura la terminologia, e deve restare leggibile e diffabile.
2. `version` è **obbligatoria**: entra nella chiave di cache, e un glossario senza versione renderebbe impossibile distinguere "stessa domanda" da "domanda nuova".
3. Una regola sconosciuta è un errore, non un avviso da ignorare: un termine che il motore non sa applicare è terminologia che l'utente crede attiva e non lo è.
4. `supportsLanguages` confronta per sottotag primario, come `writeRootLang` del piano 1: `en-US` e `en` sono la stessa lingua per questo scopo.
5. `glossaryIdentity` ordina sempre: è l'unico modo perché la chiave di cache non dipenda dall'ordine in cui i glossari sono stati caricati.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/glossary.test.ts`
Atteso: PASS, sei test.

- [ ] **Step 5: Commit**

```bash
git add core/glossary core/test/glossary.test.ts
git commit -m "feat(glossary): a hand-editable format with a version that means something"
```

---

### Task 4: Campionamento del libro

**Files:**
- Create: `core/analyze/sample.ts`, `core/test/sample.test.ts`

**Interfaces:**
- Consumes: `TranslationUnit`, `isWork` (piano 1)
- Produces: `sampleBlocks(units: TranslationUnit[], count?: number): string[][]` — `count` campioni (default 3), ognuno un gruppo di unità contigue, presi da **punti distanti** del libro.

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/sample.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sampleBlocks } from "../analyze/sample.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, state: TranslationUnit["state"] = "translate"): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n * 10, n * 10 + 5], source: `Sentence number ${n}`, raw: `Sentence number ${n}`, state,
});

describe("sampleBlocks", () => {
  it("returns three samples taken from distant parts of the book", () => {
    const units = Array.from({ length: 300 }, (_, i) => unit(i + 1));
    const samples = sampleBlocks(units);
    expect(samples).toHaveLength(3);
    expect(samples[0][0]).not.toBe(samples[2][0]);
  });

  it("never samples a unit that is not work", () => {
    const units = [unit(1, "code"), unit(2, "translate-no"), unit(3)];
    expect(sampleBlocks(units).flat()).toEqual(["Sentence number 3"]);
  });

  it("returns fewer samples than asked rather than repeating itself", () => {
    expect(sampleBlocks([unit(1)], 3)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/sample.test.ts`
Atteso: FAIL, `Cannot find module '../analyze/sample.ts'`.

- [ ] **Step 3: Implementare**

Si filtra su `isWork`, si divide l'elenco in `count` fasce uguali e da ognuna si prende un gruppo contiguo di unità dal centro, fermandosi a un tetto di caratteri (circa 2000 per campione).

**I campioni devono essere indipendenti**, perché il voto del Task 6 sia un voto e non un'eco: tre campioni presi dallo stesso capitolo dicono tre volte la stessa cosa e la maggioranza non significa niente. Con meno unità di quante ne servono si restituiscono meno campioni: ripetere lo stesso testo per riempire il numero falsifica il voto.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/sample.test.ts`
Atteso: PASS, tre test.

- [ ] **Step 5: Commit**

```bash
git add core/analyze/sample.ts core/test/sample.test.ts
git commit -m "feat(analyze): sample from distant parts, so a majority means something"
```

---

### Task 5: Identificazione della lingua

**Files:**
- Create: `core/analyze/language.ts`, `core/test/language.test.ts`

**Interfaces:**
- Consumes: `sampleBlocks` (Task 4), `LlmBackend` (Task 1)
- Produces:

```ts
export interface LanguageVerdict {
  language: string | null;              // null se non si è deciso
  method: "declared" | "voted" | "declared-and-voted" | "conflict" | "abstained" | "no-backend";
  declared?: string;                    // ciò che diceva l'OPF
  voted?: string;                       // ciò che ha detto il modello
  needsConfirmation: boolean;           // l'interfaccia deve chiedere all'utente
}
export function detectLanguage(input: {
  declared: string | null;
  units: TranslationUnit[];
  backend: LlmBackend | null;
  signal?: AbortSignal;
}): Promise<LanguageVerdict>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/language.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectLanguage } from "../analyze/language.ts";
import { FakeBackend } from "./fake/backend.ts";
import type { TranslationUnit } from "../epub/index.ts";

const units: TranslationUnit[] = Array.from({ length: 30 }, (_, i) => ({
  id: `c1.xhtml#${i}`, kind: "block", doc: "c1.xhtml", ordinal: i,
  range: [i * 10, i * 10 + 5], source: "The quick brown fox jumps over the lazy dog",
  raw: "The quick brown fox jumps over the lazy dog", state: "translate",
}));

describe("detectLanguage", () => {
  it("does not call the model when the package declares a plausible language", async () => {
    const backend = new FakeBackend([]);
    const verdict = await detectLanguage({ declared: "en", units, backend });
    expect(verdict).toMatchObject({ language: "en", method: "declared", needsConfirmation: false });
    expect(backend.prompts).toEqual([]);
  });

  it("votes when the package declares nothing", async () => {
    const backend = new FakeBackend(["en", "en", "en"]);
    const verdict = await detectLanguage({ declared: null, units, backend });
    expect(verdict).toMatchObject({ language: "en", method: "voted", needsConfirmation: false });
  });

  it("asks the user when the vote contradicts the package", async () => {
    const backend = new FakeBackend(["fr", "fr", "fr"]);
    const verdict = await detectLanguage({ declared: "en", units, backend });
    expect(verdict).toMatchObject({ method: "conflict", declared: "en", voted: "fr", needsConfirmation: true });
    expect(verdict.language).toBeNull();
  });

  it("asks the user when there is no backend to vote with", async () => {
    const verdict = await detectLanguage({ declared: null, units, backend: null });
    expect(verdict).toMatchObject({ method: "no-backend", language: null, needsConfirmation: true });
  });

  it("abstains rather than guessing when the samples disagree", async () => {
    const backend = new FakeBackend(["en", "fr", "de"]);
    const verdict = await detectLanguage({ declared: null, units, backend });
    expect(verdict).toMatchObject({ method: "abstained", needsConfirmation: true });
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/language.test.ts`
Atteso: FAIL, `Cannot find module '../analyze/language.ts'`.

- [ ] **Step 3: Implementare**

1. **L'OPF viene per primo, e se basta si ferma lì.** Una lingua dichiarata e plausibile — un tag BCP 47 ben formato — chiude la fase senza costo e senza provider. È il caso normale.
2. Se manca, si chiede al modello su tre campioni indipendenti e si prende la maggioranza. Senza maggioranza, `abstained`.
3. Se il voto contraddice l'OPF, non si sceglie: `conflict` con entrambi i valori, e decide l'utente. Sostituire d'autorità una dichiarazione dell'editore con l'opinione del modello è il tipo di iniziativa che si scopre a libro tradotto.
4. Senza backend — provider non ancora configurato — si risponde `no-backend`: **la creazione di un progetto non si blocca mai su una chiamata di rete.**
5. Il verdetto normalizza al sottotag primario: `en-US` diventa `en`.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/language.test.ts`
Atteso: PASS, cinque test.

- [ ] **Step 5: Commit**

```bash
git add core/analyze/language.ts core/test/language.test.ts
git commit -m "feat(analyze): trust the package first, ask the user when sources disagree"
```

---

### Task 6: Voto sul dominio

**Files:**
- Create: `core/analyze/domain.ts`, `core/test/domain.test.ts`

**Interfaces:**
- Consumes: `sampleBlocks` (Task 4), `Glossary` (Task 3), `LlmBackend` (Task 1)
- Produces:

```ts
export interface DomainVerdict {
  glossary: string | null;
  method: "majority" | "abstained" | "no-glossaries" | "disabled" | "user";
  votes?: string[];                 // cosa ha risposto ogni campione, per il report
  taxonomy: string[];               // i nomi tra cui si poteva scegliere, ordinati
}
export function voteDomain(input: {
  units: TranslationUnit[];
  glossaries: Glossary[];
  backend: LlmBackend;
  signal?: AbortSignal;
}): Promise<DomainVerdict>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/domain.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { voteDomain } from "../analyze/domain.ts";
import { FakeBackend } from "./fake/backend.ts";
import type { Glossary } from "../glossary/index.ts";
import type { TranslationUnit } from "../epub/index.ts";

const units: TranslationUnit[] = Array.from({ length: 60 }, (_, i) => ({
  id: `c1.xhtml#${i}`, kind: "block", doc: "c1.xhtml", ordinal: i,
  range: [i * 10, i * 10 + 5], source: `Sentence ${i}`, raw: `Sentence ${i}`, state: "translate",
}));

const glossaries: Glossary[] = [
  { name: "fantasy", version: 1, description: "Epic fantasy", sourceLanguage: "en", targetLanguage: "it", terms: [] },
  { name: "tech", version: 1, description: "Software manuals", sourceLanguage: "en", targetLanguage: "it", terms: [] },
];

describe("voteDomain", () => {
  it("takes the majority of three independent samples", async () => {
    const verdict = await voteDomain({ units, glossaries, backend: new FakeBackend(["fantasy", "fantasy", "tech"]) });
    expect(verdict).toMatchObject({ glossary: "fantasy", method: "majority" });
    expect(verdict.taxonomy).toEqual(["fantasy", "tech"]);
  });

  it("abstains when there is no majority", async () => {
    const verdict = await voteDomain({ units, glossaries, backend: new FakeBackend(["fantasy", "tech", "none"]) });
    expect(verdict).toMatchObject({ glossary: null, method: "abstained" });
  });

  it("abstains when the answer names a glossary that does not exist", async () => {
    const verdict = await voteDomain({ units, glossaries, backend: new FakeBackend(["cooking", "cooking", "cooking"]) });
    expect(verdict).toMatchObject({ glossary: null, method: "abstained" });
  });

  it("does not ask at all when there are no glossaries", async () => {
    const backend = new FakeBackend([]);
    const verdict = await voteDomain({ units, glossaries: [], backend });
    expect(verdict.method).toBe("no-glossaries");
    expect(backend.prompts).toEqual([]);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/domain.test.ts`
Atteso: FAIL, `Cannot find module '../analyze/domain.ts'`.

- [ ] **Step 3: Implementare**

Il prompt elenca i glossari **per nome e descrizione** — è a questo che serve la descrizione del Task 3 — e ammette esplicitamente la risposta `none`. Si vota su tre campioni indipendenti; vince la maggioranza assoluta.

**L'astensione è facile e rumorosa.** Terminologia sbagliata a livello di documento è peggio di nessuna terminologia, e il fallimento è silenzioso: il libro esce tradotto, coerente, e sbagliato. Quindi: nessuna maggioranza, nome inesistente, o risposta fuori formato portano tutte a `abstained`, e `taxonomy` registra tra cosa si poteva scegliere, così una corsa successiva sa distinguere "stessa domanda, tengo la risposta" da "domanda nuova, richiedo".

Il verdetto **non è vincolante**: l'utente lo corregge dall'interfaccia (piano 5), e in quel caso `method` diventa `user`.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/domain.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add core/analyze/domain.ts core/test/domain.test.ts
git commit -m "feat(analyze): vote on the glossary, and abstain loudly"
```

---

### Task 7: Candidati terminologici

**Files:**
- Create: `core/analyze/candidates.ts`, `core/test/candidates.test.ts`

**Interfaces:**
- Consumes: `sampleBlocks` (Task 4), `LlmBackend` (Task 1), `TermEntry` (Task 3)
- Produces:

```ts
export interface Candidate extends TermEntry {
  origin: "extracted";
  occurrences: number;
  context: string;                  // la frase in cui compare, per l'interfaccia
  approval: "pending" | "approved" | "rejected";
}
export interface CandidateReport {
  candidates: Candidate[];
  open: Array<{ source: string; question: string }>;   // decisioni che il modello non ha preso
  abstained: boolean;
}
export function extractCandidates(input: {
  units: TranslationUnit[];
  backend: LlmBackend;
  sourceLanguage: string;
  targetLanguage: string;
  description?: string;             // ciò che l'utente ha scritto sul libro
  signal?: AbortSignal;
}): Promise<CandidateReport>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/candidates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../analyze/candidates.ts";
import { FakeBackend } from "./fake/backend.ts";
import type { TranslationUnit } from "../epub/index.ts";

const units: TranslationUnit[] = Array.from({ length: 60 }, (_, i) => ({
  id: `c1.xhtml#${i}`, kind: "block", doc: "c1.xhtml", ordinal: i,
  range: [i * 40, i * 40 + 30],
  source: i % 2 === 0 ? "Frodo walked to Rivendell at dawn" : "The dwarf sharpened his axe",
  raw: "x", state: "translate",
}));

const answer = `TERMS 2
[t:Rivendell] rule=dnt note=place name
[t:dwarf] rule=must target=nano
END`;

describe("extractCandidates", () => {
  it("reads the candidates and attaches the sentence they came from", async () => {
    const report = await extractCandidates({
      units, backend: new FakeBackend([answer, answer, answer]),
      sourceLanguage: "en", targetLanguage: "it",
    });
    const rivendell = report.candidates.find((c) => c.source === "Rivendell")!;
    expect(rivendell).toMatchObject({ rule: "dnt", origin: "extracted", approval: "pending" });
    expect(rivendell.context).toContain("Rivendell");
    expect(rivendell.occurrences).toBeGreaterThan(1);
  });

  it("puts the user's description in the prompt", async () => {
    const backend = new FakeBackend([answer, answer, answer]);
    await extractCandidates({
      units, backend, sourceLanguage: "en", targetLanguage: "it",
      description: "Second volume of a trilogy; Frodo is a hobbit, not a person",
    });
    expect(backend.prompts[0]).toContain("Second volume of a trilogy");
  });

  it("abstains instead of guessing when the answer is malformed", async () => {
    const report = await extractCandidates({
      units, backend: new FakeBackend(["I think the main terms are Rivendell and dwarf.", "same", "same"]),
      sourceLanguage: "en", targetLanguage: "it",
    });
    expect(report).toMatchObject({ abstained: true, candidates: [] });
  });

  it("never returns a candidate already approved: everything starts pending", async () => {
    const report = await extractCandidates({
      units, backend: new FakeBackend([answer, answer, answer]),
      sourceLanguage: "en", targetLanguage: "it",
    });
    expect(report.candidates.every((c) => c.approval === "pending")).toBe(true);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/candidates.test.ts`
Atteso: FAIL, `Cannot find module '../analyze/candidates.ts'`.

- [ ] **Step 3: Implementare**

1. Il formato di risposta è a righe, con intestazione `TERMS n`, un marcatore `[t:sorgente]` per termine seguito da coppie `chiave=valore`, e terminatore `END`. Stessa filosofia del protocollo di traduzione (Task 8): conteggio dichiarato, marcatori espliciti, terminatore. Una risposta fuori formato non si interpreta a naso.
2. `occurrences` e `context` si calcolano **sul libro, non sulla risposta**: si cerca il termine nelle unità e si prende la prima frase in cui compare. È ciò che l'interfaccia mostra all'utente per decidere, e non va lasciato al modello, che potrebbe inventarlo.
3. `open` raccoglie le decisioni che il modello dichiara di non poter prendere (un nome che potrebbe essere un cognome o un luogo). Restano pendenti e **non rendono il libro incompleto**: sono una dichiarazione, non un fallimento di traduzione.
4. **Tutto nasce `pending`.** Nessun termine si applica senza approvazione; l'auto-accettazione è una scelta dell'interfaccia (piano 5), non un default del core.
5. L'astensione, come nel voto di dominio, è preferibile a un'interpretazione generosa.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/candidates.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add core/analyze/candidates.ts core/test/candidates.test.ts
git commit -m "feat(analyze): extract term candidates, count occurrences in the book itself"
```

---

### Task 8: Il protocollo

**Files:**
- Create: `core/translate/types.ts`, `core/translate/instructions.ts`, `core/translate/wire.ts`, `core/test/wire.test.ts`

**Interfaces:**
- Consumes: `TranslationUnit` (piano 1), `TermEntry` (Task 3)
- Produces:

```ts
export interface ChunkContext {
  sourceLanguage: string;
  targetLanguage: string;
  bookSummary?: string;
  description?: string;
  before: string[];                 // testo delle unità precedenti, per il contesto
  after: string[];
  chapter: { doc: string; position: number; total: number };
}
export interface TranslationRequest {
  units: TranslationUnit[];         // solo unità in stato di lavoro
  context: ChunkContext;
  terms: TermEntry[];
}
export function buildPayload(req: TranslationRequest): string;
export function buildSystem(req: TranslationRequest): string;
export interface ParsedLine { unitId: string; text: string }
export function parseResponse(raw: string): { declared: number; lines: ParsedLine[]; terminated: boolean };
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/wire.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPayload, parseResponse } from "../translate/wire.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string, state: TranslationUnit["state"] = "translate"): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + 1], source, raw: source, state,
});

const context = {
  sourceLanguage: "en", targetLanguage: "it", before: [], after: [],
  chapter: { doc: "c1.xhtml", position: 1, total: 1 },
};

describe("buildPayload", () => {
  it("declares how many units it sends and marks each one", () => {
    const payload = buildPayload({ units: [unit(1, "One"), unit(2, "Two")], context, terms: [] });
    expect(payload).toContain("UNITS 2");
    expect(payload).toContain("[u:c1.xhtml#1]");
    expect(payload).toContain("[u:c1.xhtml#2]");
    expect(payload.trimEnd().endsWith("END")).toBe(true);
  });

  it("refuses a unit that is not work", () => {
    expect(() => buildPayload({ units: [unit(1, "x = 1", "code")], context, terms: [] })).toThrow();
  });

  it("puts the active terms in the payload with their rule", () => {
    const payload = buildPayload({
      units: [unit(1, "Rivendell is far")], context,
      terms: [{ source: "Rivendell", rule: "dnt", origin: "glossary" }],
    });
    expect(payload).toContain("Rivendell");
    expect(payload).toContain("dnt");
  });
});

describe("parseResponse", () => {
  it("reads a well formed answer", () => {
    const parsed = parseResponse(`UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue\nEND`);
    expect(parsed).toEqual({
      declared: 2, terminated: true,
      lines: [{ unitId: "c1.xhtml#1", text: "Uno" }, { unitId: "c1.xhtml#2", text: "Due" }],
    });
  });

  it("keeps a multi-line translation whole", () => {
    const parsed = parseResponse(`UNITS 1\n[u:c1.xhtml#1]\nPrima riga\nSeconda riga\nEND`);
    expect(parsed.lines[0].text).toBe("Prima riga\nSeconda riga");
  });

  it("reports the missing terminator instead of trusting a truncated answer", () => {
    const parsed = parseResponse(`UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDu`);
    expect(parsed.terminated).toBe(false);
  });

  it("ignores chatter around the block", () => {
    const parsed = parseResponse(`Sure, here you go:\nUNITS 1\n[u:c1.xhtml#1]\nUno\nEND\nHope this helps!`);
    expect(parsed.lines).toEqual([{ unitId: "c1.xhtml#1", text: "Uno" }]);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/wire.test.ts`
Atteso: FAIL, `Cannot find module '../translate/wire.ts'`.

- [ ] **Step 3: Implementare**

Il formato, in entrambe le direzioni:

```
UNITS 3
[u:c1.xhtml#1]
Testo della prima unità
[u:c1.xhtml#2]
Testo della seconda, che può
occupare più righe
[u:c1.xhtml#3]
Testo della terza
END
```

Tre proprietà, e ognuna serve a un livello di validazione del Task 9: il **conteggio dichiarato** rende visibile una risposta parziale; il **marcatore esplicito con l'id** rende impossibile allineare per posizione; il **terminatore** distingue una risposta finita da una troncata.

`buildPayload` **rifiuta qualunque unità non in stato di lavoro**: la selezione è del pianificatore, e un guardiano qui impedisce che un difetto a monte faccia tradurre codice a pagamento.

`instructions.ts` costruisce il messaggio di sistema, e contiene le regole di traduzione: preservare i segnaposto numerati esattamente come arrivano; non tradurre ciò che è dentro un segnaposto opaco; **riprodurre invariati comandi, frammenti di codice, sessioni di console e output che non portano marcatura**, perché il libro può contenerne senza che il markup lo dica; applicare i termini `dnt` e `must`; rispondere solo nel formato, senza commenti. Chi tocca queste regole alza `PROMPT_VERSION` nello stesso commit.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/wire.test.ts`
Atteso: PASS, sette test.

- [ ] **Step 5: Commit**

```bash
git add core/translate/types.ts core/translate/instructions.ts core/translate/wire.ts core/test/wire.test.ts
git commit -m "feat(translate): a wire format that makes a partial answer visible"
```

---

### Task 9: I cinque livelli di validazione

**Files:**
- Create: `core/translate/validate.ts`, `core/test/validate.test.ts`

**Interfaces:**
- Consumes: `parseResponse` (Task 8), `TranslationUnit` (piano 1)
- Produces:

```ts
export type RejectionCode =
  | "no-structure"        // livello 1: manca l'intestazione o il terminatore
  | "count-mismatch"      // livello 2: le unità estratte non sono quelle dichiarate
  | "empty-text"          // livello 3: un'unità è tornata vuota
  | "marker-residue"      // livello 3: un marcatore di protocollo dentro il testo
  | "unknown-id"          // livello 4: un id che non era stato richiesto
  | "duplicate-id"        // livello 4
  | "missing-id"          // livello 4
  | "placeholder-mismatch"; // livello 5

export interface Rejection { unitId: string | null; code: RejectionCode; detail: string }
export interface Validation {
  accepted: Map<string, string>;     // id unità → testo tradotto
  rejections: Rejection[];
  truncated: boolean;                // la risposta si è interrotta per lunghezza
}
export function validate(raw: string, requested: TranslationUnit[], finishReason: "stop" | "length" | "other"): Validation;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validate } from "../translate/validate.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + 1], source, raw: source, state: "translate",
  placeholders: source.includes("<0>")
    ? [{ index: 0, open: "<em>", close: "</em>", opaque: false }]
    : undefined,
});

const two = [unit(1, "One"), unit(2, "Two")];

describe("validate", () => {
  it("accepts a well formed answer", () => {
    const v = validate(`UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue\nEND`, two, "stop");
    expect(v.rejections).toEqual([]);
    expect(v.accepted.get("c1.xhtml#2")).toBe("Due");
  });

  it("level 1: rejects an answer with no structure at all", () => {
    const v = validate("Certo, ecco la traduzione: Uno e Due", two, "stop");
    expect(v.rejections[0].code).toBe("no-structure");
    expect(v.accepted.size).toBe(0);
  });

  it("level 2: rejects when the count does not match what arrived", () => {
    const v = validate(`UNITS 2\n[u:c1.xhtml#1]\nUno\nEND`, two, "stop");
    expect(v.rejections.some((r) => r.code === "count-mismatch")).toBe(true);
  });

  it("level 3: rejects an empty translation and a marker left in the text", () => {
    const v = validate(`UNITS 2\n[u:c1.xhtml#1]\n\n[u:c1.xhtml#2]\nDue [u:c1.xhtml#3]\nEND`, two, "stop");
    expect(v.rejections.map((r) => r.code).sort()).toEqual(["empty-text", "marker-residue"]);
  });

  it("level 4: keeps the good units and rejects only the unknown id", () => {
    const v = validate(`UNITS 3\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue\n[u:c9.xhtml#9]\nNove\nEND`, two, "stop");
    expect(v.accepted.size).toBe(2);
    expect(v.rejections.map((r) => r.code)).toContain("unknown-id");
  });

  it("level 5: rejects a translation that dropped a placeholder", () => {
    const withPh = [unit(1, "A <0>bold</0> claim")];
    const v = validate(`UNITS 1\n[u:c1.xhtml#1]\nUna affermazione audace\nEND`, withPh, "stop");
    expect(v.rejections[0].code).toBe("placeholder-mismatch");
  });

  it("marks truncation separately, because it is the only reason to split a chunk", () => {
    const v = validate(`UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDu`, two, "length");
    expect(v.truncated).toBe(true);
    expect(v.accepted.get("c1.xhtml#1")).toBe("Uno");
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/validate.test.ts`
Atteso: FAIL, `Cannot find module '../translate/validate.ts'`.

- [ ] **Step 3: Implementare**

I livelli, nell'ordine, ognuno che si ferma sul proprio errore ma **conserva tutto ciò che è valido**:

1. **Struttura** — intestazione `UNITS n` e terminatore `END` presenti. Senza, nessuna unità è accettabile.
2. **Estrazione** — il numero di blocchi estratti coincide con `n`.
3. **Decodifica** — nessun testo vuoto, nessun marcatore di protocollo rimasto dentro una traduzione.
4. **Insieme esatto degli id** — gli id ricevuti sono esattamente quelli richiesti: nessuno sconosciuto, nessun duplicato, nessuno mancante. **Non si allinea mai per posizione**, che è il modo in cui una risposta plausibile finisce nel posto sbagliato.
5. **Segnaposto** — ogni traduzione porta gli stessi segnaposto dell'originale, bilanciati, senza aggiunte.

`truncated` è separato dalle rifiutate: **è l'unica condizione che giustifica di spezzare un gruppo** e riprovare in due. Tutte le altre si affrontano rimandando le sole unità rifiutate con la diagnosi allegata, senza cambiare la dimensione del gruppo.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/validate.test.ts`
Atteso: PASS, sette test.

- [ ] **Step 5: Commit**

```bash
git add core/translate/validate.ts core/test/validate.test.ts
git commit -m "feat(translate): five levels, and never align by position"
```

---

### Task 10: Raggruppamento e finestra di contesto

**Files:**
- Create: `core/translate/plan.ts`, `core/test/plan.test.ts`

**Interfaces:**
- Consumes: `TranslationUnit`, `isWork` (piano 1), `ChunkContext` (Task 8)
- Produces:

```ts
export interface Chunk {
  units: TranslationUnit[];
  context: ChunkContext;
}
export function planChunks(input: {
  units: TranslationUnit[];          // tutte le unità del libro, in ordine
  sourceLanguage: string;
  targetLanguage: string;
  bookSummary?: string;
  description?: string;
  maxCharsPerChunk?: number;         // default 6000
  contextWindow?: number;            // default 2 unità prima e 2 dopo
  done?: Set<string>;                // unità già tradotte, da saltare
}): Chunk[];
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planChunks } from "../translate/plan.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, state: TranslationUnit["state"] = "translate", text = `Sentence ${n}`): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n * 100, n * 100 + 50], source: text, raw: text, state,
});

describe("planChunks", () => {
  it("only plans work units, but keeps the others as context", () => {
    const units = [unit(1), unit(2, "code", "x = 1"), unit(3)];
    const chunks = planChunks({ units, sourceLanguage: "en", targetLanguage: "it" });
    expect(chunks.flatMap((c) => c.units.map((u) => u.id))).toEqual(["c1.xhtml#1", "c1.xhtml#3"]);
    expect(chunks[0].context.after.join(" ")).toContain("x = 1");
  });

  it("splits on the character budget", () => {
    const units = Array.from({ length: 20 }, (_, i) => unit(i + 1, "translate", "x".repeat(500)));
    const chunks = planChunks({ units, sourceLanguage: "en", targetLanguage: "it", maxCharsPerChunk: 2000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.units.reduce((n, u) => n + u.source.length, 0)).toBeLessThanOrEqual(2000);
    }
  });

  it("gives a single oversized unit a chunk of its own instead of dropping it", () => {
    const units = [unit(1, "translate", "y".repeat(9000))];
    const chunks = planChunks({ units, sourceLanguage: "en", targetLanguage: "it", maxCharsPerChunk: 2000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].units).toHaveLength(1);
  });

  it("skips what is already done, and still uses it as context", () => {
    const units = [unit(1), unit(2), unit(3)];
    const chunks = planChunks({
      units, sourceLanguage: "en", targetLanguage: "it", done: new Set(["c1.xhtml#2"]),
    });
    expect(chunks.flatMap((c) => c.units.map((u) => u.id))).toEqual(["c1.xhtml#1", "c1.xhtml#3"]);
  });

  it("never crosses a document boundary inside a chunk", () => {
    const other = { ...unit(1), id: "c2.xhtml#1", doc: "c2.xhtml" };
    const chunks = planChunks({ units: [unit(1), other], sourceLanguage: "en", targetLanguage: "it" });
    expect(chunks).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/plan.test.ts`
Atteso: FAIL, `Cannot find module '../translate/plan.ts'`.

- [ ] **Step 3: Implementare**

1. Si filtra su `isWork` e si toglie ciò che è in `done`, ma **le unità escluse restano disponibili come contesto**: il capitolo si legge per intero, si traduce solo ciò che va tradotto.
2. Il budget è in caratteri, non in token: il core non conosce il tokenizzatore del modello, e non deve. Il valore prudente serve a stare lontani dal limite di output, non a stimarlo.
3. Un'unità più grande del budget **ha un gruppo tutto suo**. Non si spezza un'unità: è l'atomo, e spezzarla romperebbe i segnaposto.
4. Un gruppo non attraversa mai il confine di un documento: la finestra di contesto avrebbe senso solo dentro lo stesso capitolo, e l'ordinale è per documento.
5. La finestra porta il testo sorgente delle unità vicine, prima e dopo, comprese quelle che non si traducono: un titolo che non si traduce spiega comunque il paragrafo che segue.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/plan.test.ts`
Atteso: PASS, cinque test.

- [ ] **Step 5: Commit**

```bash
git add core/translate/plan.ts core/test/plan.test.ts
git commit -m "feat(translate): plan by character budget, never split a unit"
```

---

### Task 11: Termini attivi e aderenza

**Files:**
- Create: `core/translate/terms.ts`, `core/test/terms.test.ts`

**Interfaces:**
- Consumes: `TermEntry` (Task 3), `TranslationUnit` (piano 1)
- Produces:

```ts
export function mergeTerms(glossaryTerms: TermEntry[], projectTerms: TermEntry[]): TermEntry[];
export function termsForChunk(terms: TermEntry[], units: TranslationUnit[]): TermEntry[];
export interface Adherence { checked: number; respected: number; violations: Array<{ unitId: string; term: string }> }
export function measureAdherence(terms: TermEntry[], pairs: Array<{ unit: TranslationUnit; text: string }>): Adherence;
export function unitsAffectedByTerms(units: TranslationUnit[], changed: TermEntry[]): string[];
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/terms.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { measureAdherence, mergeTerms, termsForChunk, unitsAffectedByTerms } from "../translate/terms.ts";
import type { TermEntry } from "../glossary/index.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + 1], source, raw: source, state: "translate",
});

const dnt = (s: string): TermEntry => ({ source: s, rule: "dnt", origin: "glossary" });
const must = (s: string, t: string, origin: TermEntry["origin"] = "glossary"): TermEntry =>
  ({ source: s, target: t, rule: "must", origin });

describe("mergeTerms", () => {
  it("lets a project term win over a glossary term for the same source", () => {
    const merged = mergeTerms([must("dwarf", "nano")], [must("dwarf", "nanerottolo", "manual")]);
    expect(merged).toEqual([must("dwarf", "nanerottolo", "manual")]);
  });
});

describe("termsForChunk", () => {
  it("sends only the terms the chunk actually contains", () => {
    const terms = [dnt("Rivendell"), dnt("Mordor")];
    expect(termsForChunk(terms, [unit(1, "The road to Rivendell")])).toEqual([dnt("Rivendell")]);
  });
});

describe("measureAdherence", () => {
  it("counts a dnt term left untouched as respected", () => {
    const a = measureAdherence([dnt("Rivendell")], [{ unit: unit(1, "To Rivendell"), text: "Verso Rivendell" }]);
    expect(a).toMatchObject({ checked: 1, respected: 1, violations: [] });
  });

  it("reports a dnt term that was translated anyway", () => {
    const a = measureAdherence([dnt("Rivendell")], [{ unit: unit(1, "To Rivendell"), text: "Verso Forravalle" }]);
    expect(a.violations).toEqual([{ unitId: "c1.xhtml#1", term: "Rivendell" }]);
  });

  it("reports a must term whose required rendering is missing", () => {
    const a = measureAdherence([must("dwarf", "nano")], [{ unit: unit(1, "the dwarf"), text: "il nanetto" }]);
    expect(a.violations).toEqual([{ unitId: "c1.xhtml#1", term: "dwarf" }]);
  });
});

describe("unitsAffectedByTerms", () => {
  it("names only the units that contain a changed term", () => {
    const units = [unit(1, "To Rivendell"), unit(2, "A quiet evening")];
    expect(unitsAffectedByTerms(units, [dnt("Rivendell")])).toEqual(["c1.xhtml#1"]);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/terms.test.ts`
Atteso: FAIL, `Cannot find module '../translate/terms.ts'`.

- [ ] **Step 3: Implementare**

1. `mergeTerms`: a parità di `source`, il termine di progetto batte quello di glossario. Chi ha deciso su questo libro ha più contesto di chi ha scritto il glossario.
2. `termsForChunk`: si mandano solo i termini che compaiono nelle unità del gruppo. Mandare l'intero glossario a ogni chiamata costa, distrae il modello e non serve.
3. `measureAdherence` è una misura, non un blocco: dà il numero che il report mostra. Non si ritraduce d'ufficio per una violazione — un `must` può legittimamente non comparire per ragioni grammaticali — ma il numero dice se il glossario sta funzionando.
4. **`unitsAffectedByTerms` è ciò che rende selettiva l'invalidazione.** Quando l'utente cambia un termine dopo che la traduzione è partita, si ritraducono solo le unità che lo contengono, non il libro. Il prototipo buttava via la sessione intera a ogni cambio di configurazione: qui è una query.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/terms.test.ts`
Atteso: PASS, sei test.

- [ ] **Step 5: Commit**

```bash
git add core/translate/terms.ts core/test/terms.test.ts
git commit -m "feat(translate): a term change invalidates the units that carry it, not the book"
```

---

### Task 12: L'indice del codice

**Files:**
- Create: `core/analyze/code.ts`, `core/test/code.test.ts`

**Interfaces:**
- Consumes: `TranslationUnit`, `UnitState` (piano 1), `LlmBackend` (Task 1)
- Produces:

```ts
export interface CodeVerdict { unitId: string; verdict: "code" | "prose" }
export interface CodeIndex {
  marked: string[];        // unità che erano "translate" e diventano "maybe-code"
  freed: string[];         // unità che erano "code" per il CSS e tornano "translate"
  abstained: number;       // batch che hanno esaurito i tentativi
  sourceHash: string;      // a quale sorgente si riferisce questo indice
}
export function indexCodeBlocks(input: {
  units: TranslationUnit[];
  backend: LlmBackend;
  sourceHash: string;
  batchSize?: number;      // default 20
  signal?: AbortSignal;
}): Promise<CodeIndex>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/code.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { indexCodeBlocks } from "../analyze/code.ts";
import { FakeBackend } from "./fake/backend.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string, state: TranslationUnit["state"], reason?: string): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + 1], source, raw: source, state, reason,
});

const answer = (rows: string) => `VERDICTS ${rows.trim().split("\n").length}\n${rows.trim()}\nEND`;

describe("indexCodeBlocks", () => {
  it("marks prose the deterministic rules missed as maybe-code", async () => {
    const units = [unit(1, "npm install --save-dev vitest", "translate")];
    const index = await indexCodeBlocks({
      units, sourceHash: "h1",
      backend: new FakeBackend([answer("[v:c1.xhtml#1] code")]),
    });
    expect(index.marked).toEqual(["c1.xhtml#1"]);
  });

  it("frees prose the stylesheet over-protected", async () => {
    const units = [unit(1, "The src/ directory holds the sources", "code", "css-code-surface")];
    const index = await indexCodeBlocks({
      units, sourceHash: "h1",
      backend: new FakeBackend([answer("[v:c1.xhtml#1] prose")]),
    });
    expect(index.freed).toEqual(["c1.xhtml#1"]);
  });

  it("never frees a unit whose state came from the markup itself", async () => {
    const units = [unit(1, "ls -la", "code")];
    const index = await indexCodeBlocks({
      units, sourceHash: "h1",
      backend: new FakeBackend([answer("[v:c1.xhtml#1] prose")]),
    });
    expect(index.freed).toEqual([]);
  });

  it("turns a malformed batch into an abstention, not a guess", async () => {
    const units = [unit(1, "Some text", "translate")];
    const index = await indexCodeBlocks({
      units, sourceHash: "h1",
      backend: new FakeBackend(["I think unit one is code", "still not the format"]),
    });
    expect(index).toMatchObject({ marked: [], freed: [], abstained: 1 });
  });

  it("does not ask about units nobody would translate anyway", async () => {
    const backend = new FakeBackend([]);
    const index = await indexCodeBlocks({
      units: [unit(1, "var a = 1", "never-translated"), unit(2, "Brand", "translate-no")],
      sourceHash: "h1", backend,
    });
    expect(backend.prompts).toEqual([]);
    expect(index.marked).toEqual([]);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/code.test.ts`
Atteso: FAIL, `Cannot find module '../analyze/code.ts'`.

- [ ] **Step 3: Implementare**

Il passaggio guarda due popolazioni: le unità `translate`, che potrebbero essere codice non marcato, e le unità `code` **il cui stato viene dal CSS** (`reason: "css-code-surface"`), che potrebbero essere prosa protetta troppo.

Tre regole che decidono quanto vale il verdetto:

1. **Un'astensione non cambia mai lo stato deterministico.** Un batch fuori formato, dopo i suoi ritentativi, diventa un'astensione contata nel report: nessuna unità cambia.
2. **Ciò che il markup stesso dichiara non si libera.** Un `<pre>` o un `<code>` è codice perché l'autore l'ha scritto così; solo la deduzione dal CSS, che è indiziaria, può essere ribaltata.
3. **Un'unità sospettata non viene trattenuta: viene inoltrata.** Diventa `maybe-code`, che è uno stato di lavoro: va al traduttore con il sospetto allegato, e chi la legge nel contesto decide. Misurato su un libro vero, la combinazione "il CSS tace e il modello dice codice" sbaglia molto più spesso di quanto azzecchi — `The src/ directory` è prosa con dentro un percorso. Bloccarla sarebbe un danno; segnalarla è un aiuto.

`sourceHash` lega l'indice al libro da cui è stato prodotto: un indice che non corrisponde al sorgente corrente si butta, non si riusa.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/code.test.ts`
Atteso: PASS, cinque test.

- [ ] **Step 5: Commit**

```bash
git add core/analyze/code.ts core/test/code.test.ts
git commit -m "feat(analyze): a suspected code unit is forwarded, not withheld"
```

---

### Task 13: Il motore

**Files:**
- Create: `core/translate/engine.ts`, `core/test/engine.test.ts`

**Interfaces:**
- Consumes: tutto il piano
- Produces:

```ts
export interface ChunkOutcome {
  translated: Map<string, string>;                 // id unità → testo accettato
  fellBack: Array<{ unitId: string; reason: RejectionCode | "exhausted" }>;
  attempts: number;
  tokensIn: number;
  tokensOut: number;
}
export function translateChunk(input: {
  chunk: Chunk;
  terms: TermEntry[];
  backend: LlmBackend;
  maxAttempts?: number;                            // default 3
  signal?: AbortSignal;
}): Promise<ChunkOutcome>;

export interface RunSummary {
  units: { total: number; translated: number; fellBack: number; identical: number };
  notTranslated: Record<string, number>;           // per stato
  tokensIn: number; tokensOut: number;
}
export function translateUnits(input: {
  units: TranslationUnit[];
  store: ProjectStore;
  backend: LlmBackend;
  progress: ProgressSink;
  cacheKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  concurrency?: number;                            // default 2
  signal?: AbortSignal;
}): Promise<RunSummary>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { translateChunk, translateUnits } from "../translate/engine.ts";
import { FakeBackend } from "./fake/backend.ts";
import { FakeStore } from "./fake/store.ts";
import type { TranslationUnit } from "../epub/index.ts";

const unit = (n: number, source: string): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n * 100, n * 100 + 50], source, raw: source, state: "translate",
});

const chunk = (units: TranslationUnit[]) => ({
  units,
  context: {
    sourceLanguage: "en", targetLanguage: "it", before: [], after: [],
    chapter: { doc: "c1.xhtml", position: 1, total: 1 },
  },
});

describe("translateChunk", () => {
  it("accepts a good answer in one attempt", async () => {
    const out = await translateChunk({
      chunk: chunk([unit(1, "One"), unit(2, "Two")]),
      terms: [],
      backend: new FakeBackend([`UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDue\nEND`]),
    });
    expect(out.attempts).toBe(1);
    expect(out.translated.get("c1.xhtml#2")).toBe("Due");
    expect(out.fellBack).toEqual([]);
  });

  it("resends only the rejected unit, with the diagnosis", async () => {
    const backend = new FakeBackend([
      `UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\n\nEND`,
      `UNITS 1\n[u:c1.xhtml#2]\nDue\nEND`,
    ]);
    const out = await translateChunk({ chunk: chunk([unit(1, "One"), unit(2, "Two")]), terms: [], backend });
    expect(out.attempts).toBe(2);
    expect(out.translated.size).toBe(2);
    expect(backend.prompts[1]).toContain("c1.xhtml#2");
    expect(backend.prompts[1]).not.toContain("c1.xhtml#1");
    expect(backend.prompts[1]).toContain("empty-text");
  });

  it("falls a unit back to source when the attempts run out, and says why", async () => {
    const bad = `UNITS 1\n[u:c1.xhtml#1]\n\nEND`;
    const out = await translateChunk({
      chunk: chunk([unit(1, "One")]), terms: [],
      backend: new FakeBackend([bad, bad, bad]),
    });
    expect(out.translated.size).toBe(0);
    expect(out.fellBack).toEqual([{ unitId: "c1.xhtml#1", reason: "exhausted" }]);
  });

  it("splits the chunk only when the answer was truncated", async () => {
    const backend = new FakeBackend((call) =>
      call.prompt.includes("UNITS 2")
        ? { text: `UNITS 2\n[u:c1.xhtml#1]\nUno\n[u:c1.xhtml#2]\nDu`, tokensIn: 1, tokensOut: 1, finishReason: "length" }
        : { text: `UNITS 1\n[u:c1.xhtml#2]\nDue\nEND`, tokensIn: 1, tokensOut: 1, finishReason: "stop" });
    const out = await translateChunk({ chunk: chunk([unit(1, "One"), unit(2, "Two")]), terms: [], backend });
    expect(out.translated.size).toBe(2);
  });

  it("stops on an abort signal instead of finishing the chunk", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(translateChunk({
      chunk: chunk([unit(1, "One")]), terms: [],
      backend: new FakeBackend([`UNITS 1\n[u:c1.xhtml#1]\nUno\nEND`]),
      signal: controller.signal,
    })).rejects.toThrow();
  });
});

describe("translateUnits", () => {
  it("writes each unit as soon as it is confirmed, so a pause costs nothing", async () => {
    const store = new FakeStore();
    const backend = new FakeBackend([`UNITS 1\n[u:c1.xhtml#1]\nUno\nEND`, `UNITS 1\n[u:c1.xhtml#2]\nDue\nEND`]);
    await translateUnits({
      units: [unit(1, "One"), unit(2, "Two")], store, backend,
      progress: { report() {} }, cacheKey: "k1",
      sourceLanguage: "en", targetLanguage: "it", concurrency: 1,
    });
    expect((await store.translations("k1")).size).toBe(2);
  });

  it("skips what the cache already holds under the same key", async () => {
    const store = new FakeStore();
    await store.putTranslation({ unitId: "c1.xhtml#1", text: "Uno", cacheKey: "k1", attempts: 1, outcome: "translated" });
    const backend = new FakeBackend([`UNITS 1\n[u:c1.xhtml#2]\nDue\nEND`]);
    await translateUnits({
      units: [unit(1, "One"), unit(2, "Two")], store, backend,
      progress: { report() {} }, cacheKey: "k1",
      sourceLanguage: "en", targetLanguage: "it", concurrency: 1,
    });
    expect(backend.prompts).toHaveLength(1);
  });

  it("records a fallback as a degradation event", async () => {
    const store = new FakeStore();
    const bad = `UNITS 1\n[u:c1.xhtml#1]\n\nEND`;
    await translateUnits({
      units: [unit(1, "One")], store, backend: new FakeBackend([bad, bad, bad]),
      progress: { report() {} }, cacheKey: "k1",
      sourceLanguage: "en", targetLanguage: "it", concurrency: 1,
    });
    expect(store.events.map((e) => e.code)).toContain("unit-fell-back");
    expect(store.events.find((e) => e.code === "unit-fell-back")?.severity).toBe("degradation");
  });

  it("counts a translation identical to the source instead of hiding it", async () => {
    const store = new FakeStore();
    const summary = await translateUnits({
      units: [unit(1, "Frodo")], store, backend: new FakeBackend([`UNITS 1\n[u:c1.xhtml#1]\nFrodo\nEND`]),
      progress: { report() {} }, cacheKey: "k1",
      sourceLanguage: "en", targetLanguage: "it", concurrency: 1,
    });
    expect(summary.units.identical).toBe(1);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/engine.test.ts`
Atteso: FAIL, `Cannot find module '../translate/engine.ts'`.

- [ ] **Step 3: Implementare**

1. **Il ritentativo conserva ciò che è valido.** Le unità accettate restano; si rimandano solo quelle rifiutate, e il payload del secondo tentativo porta la **diagnosi**: il codice di rifiuto e cosa ci si aspettava. Un ritentativo che rimanda tutto identico spera in un caso fortunato e paga per l'intero gruppo.
2. **Il budget dei tentativi è lineare**, non esponenziale: tre per gruppo, poi le unità ancora rifiutate cadono sul sorgente con `reason: "exhausted"`. Un motore che riprova all'infinito consuma denaro senza che nessuno lo veda finché non arriva la fattura.
3. **Solo il troncamento spezza un gruppo.** Ogni altro rifiuto si affronta a parità di dimensione.
4. **Ogni unità confermata si scrive subito** su `ProjectStore`. È questo che rende la pausa gratuita: fermarsi non perde nulla, e riprendere significa ricalcolare cosa manca, non ricordare dove si era.
5. **La cache si consulta con la chiave.** Un'unità già tradotta sotto la stessa chiave non si ritraduce.
6. **Ogni degradazione è un evento.** `unit-fell-back` e `chunk-exhausted` hanno `severity: "degradation"` e sono ciò che al piano 4 porta il progetto a `incomplete`.
7. **Una traduzione identica al sorgente si conta**, non si nasconde: sopra il 5% di identiche il report lo segnala, perché è il sintomo di un modello che restituisce l'input.
8. `signal` si controlla prima di ogni chiamata e la propaga al backend: la pausa dell'utente non deve aspettare la fine del gruppo.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/engine.test.ts`
Atteso: PASS, nove test.

- [ ] **Step 5: Eseguire l'intera suite e il typecheck**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
npm test -w core && npm run typecheck -w core
```

- [ ] **Step 6: Commit**

```bash
git add core/translate/engine.ts core/test/engine.test.ts
git commit -m "feat(translate): keep what is valid, resend with the diagnosis, write as you go"
```

---

### Task 14: Il confine sui modelli

**Files:**
- Modify: `core/test/boundary.test.ts`

**Interfaces:**
- Consumes: il test di confine del piano 1
- Produces: la regola che impedisce a `core/translate/` e `core/analyze/` di nominare un modello concreto.

- [ ] **Step 1: Estendere il test**

Aggiungere a `core/test/boundary.test.ts`:

```ts
const MODEL_NAMES = [/claude-/, /gpt-[0-9]/, /deepseek-/, /gemini-/, /llama-/, /mistral-/];

it("neither translate nor analyze names a concrete model", async () => {
  const offenders: string[] = [];
  for (const dir of ["core/translate", "core/analyze"]) {
    for (const file of await sources(dir)) {
      const text = await readFile(file, "utf8");
      for (const rule of MODEL_NAMES) if (rule.test(text)) offenders.push(`${file}: ${rule}`);
    }
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Eseguirlo**

Run: `npx vitest run core/test/boundary.test.ts`
Atteso: PASS. Se fallisce, il nome di un modello è finito in un commento o in un prompt: va tolto, non aggirato.

- [ ] **Step 3: Commit**

```bash
git add core/test/boundary.test.ts
git commit -m "test(core): the model-facing core may not name a model"
```

---

## Definizione di finito

- `npm test -w core` verde, `npm run typecheck -w core` senza errori.
- Il test di confine impedisce a `core/` di importare Electron, `node:sqlite` o un provider, e a `core/translate/` e `core/analyze/` di nominare un modello.
- Nessun test tocca la rete: il backend è sempre finto, e il finto lancia quando le risposte scritte finiscono.
- Le cinque fasi che spendono — lingua, dominio, candidati, indice del codice, traduzione — hanno tutte un percorso di astensione testato.

**Non è compreso**: la risoluzione di un modello vero, il database, la macchina a stati, l'interfaccia. Il motore di questo piano non sa chi lo chiama.

## Rischio dichiarato

I test coprono ogni modo in cui il backend può fallire, ma **nessuno costruisce un backend funzionante**, perché servirebbe la rete. Un errore di cablaggio nell'adattatore reale — che nasce nel piano 4 — passerebbe l'intera suite. È il motivo per cui il piano 4 prevede una prova manuale con un provider vero prima di considerarsi finito.
