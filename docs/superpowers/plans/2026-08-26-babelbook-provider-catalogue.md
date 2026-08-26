# babelBook — Piano 7: il catalogo dei provider, e i modelli locali

**Stato: non iniziato**, al 2026-08-26.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** aggiungere un provider deve voler dire **sceglierlo e incollare la chiave**. I modelli, i loro prezzi, la finestra di contesto e cosa sanno fare li scopre l'applicazione. Un modello che gira sul tuo computer — Ollama, LM Studio — si aggiunge senza nemmeno la chiave.

**Architecture:** un catalogo esterno ([models.dev](https://models.dev)) fornisce i metadati; un'unica interrogazione all'endpoint (`GET /v1/models`) fornisce cosa quella chiave vede davvero. I due si fondono: il catalogo arricchisce ciò che l'endpoint elenca. Niente di tutto questo entra in `core/`, che resta puro e senza rete.

**Tech Stack:** models.dev, `fetch` di Node, `node:zlib`, `safeStorage`, la macchina esistente dei provider.

**Piani precedenti:** 1–5 completi, 6 a sei task su otto.

---

## Cosa ho verificato prima di scrivere

Misurato, non ricordato.

- **`https://models.dev/api.json` esiste**: 4,3 MB, **203 provider**, 7339 modelli. Ogni provider porta `id`, `name`, `npm` (il pacchetto AI SDK), `env` (i nomi delle variabili d'ambiente), `doc`. Ogni modello porta `cost` (`input`/`output`/`cache_read`/`cache_write`, per milione di token), `limit` (`context`/`output`) e le capacità: `tool_call`, `reasoning` con le sue `reasoning_options`, `structured_output`, `attachment`, modalità.
- **Sfrondato di ciò che non ci serve pesa 1,59 MB, e 160 KB compresso.** Un'istantanea inclusa nel pacchetto costa quanto un'icona: l'applicazione può funzionare senza rete.
- **163 provider su 203 usano `@ai-sdk/openai-compatible`.** L'endpoint compatibile non è l'eccezione, è la norma.
- **Ollama espone `GET /v1/models`** su `http://localhost:11434/v1/`; la chiave è richiesta e ignorata (si manda `ollama`).
- **LM Studio espone `GET /v1/models`** su `http://localhost:1234/v1`, senza alcuna chiave.
- **Ollama locale non è nel catalogo** (c'è `ollama-cloud`), e `lmstudio` c'è con **tre** modelli — quelli che qualcuno ha catalogato, non quelli che hai installato tu. Per i runtime locali il catalogo è inutile per costruzione: l'elenco può venire solo dal server in esecuzione.
- **Nessuno dei due runtime gira su questa macchina** (connessione rifiutata su entrambe le porte). Le due righe qui sopra vengono dalla documentazione, **non da una verifica dal vivo**: il Task 3 le deve confermare contro un'istanza vera prima di dichiararsi fatto.

### Il fatto che decide il disegno

Ollama, LM Studio e 163 provider su 203 rispondono tutti allo stesso `GET /v1/models`. **Un solo meccanismo copre quasi tutto**, e quello che il catalogo aggiunge sono i metadati che un endpoint non dice: quanto costa, quanto contesto regge, cosa sa fare.

Quindi non ci sono due sistemi da mantenere: c'è una scoperta, e un arricchimento.

### Una decisione che questo piano ribalta

`app/main/providers/store.ts` lascia tutti i prezzi a `null`, con un commento che dice che *un prezzo inventato è peggio di nessun prezzo, perché un numero sullo schermo viene creduto*. Era giusto, e la conseguenza è che oggi **la stima non mostra mai denaro**: `new-project.ts` passa `priceIn: null, priceOut: null` fisso, e `estimate()` sa calcolare un costo che non le viene mai chiesto.

models.dev cambia la premessa: quel numero non lo inventiamo noi, ha una data ed è mantenuto. La regola resta la stessa — **mai un prezzo inventato** — ma ora esiste un prezzo che non lo è.

### Cosa non copiamo da opencode

- **Gli OAuth** (Copilot, ChatGPT Plus): superficie grossa, e la spec dice "solo api".
- **Il file di configurazione JSON**: qui c'è SQLite e una finestra.
- **`auth.json` a `0600`**: `safeStorage` è più forte, e c'è già.

---

## Global Constraints

- **`core/` non tocca la rete e non conosce il catalogo.** Resta il test di confine.
- **Offline è il caso normale, non l'errore.** Senza rete si usa l'istantanea inclusa, senza un messaggio d'allarme.
- **Nessuna chiave lascia il processo main**, come già oggi.
- **Mai un prezzo inventato.** Se il catalogo non conosce un modello, il prezzo resta assente e la stima mostra solo token.
- **L'utente non digita mai l'id di un modello**, se non in un campo esplicitamente dichiarato come scorciatoia per casi che il catalogo non copre.
- **Codice e commenti in inglese**, documenti in italiano.
- **Commit a ogni task.**

## Struttura dei file

```
app/
  scripts/fetch-catalog.mjs        rigenera l'istantanea inclusa
  catalog/snapshot.json.gz         160 KB, spediti col pacchetto
  main/catalog/
    shape.ts                       tipi e sfrondatura, puri
    load.ts                        istantanea, cache su disco, ETag, aggiornamento
    discover.ts                    GET /v1/models contro un endpoint
    local.ts                       Ollama e LM Studio: sonda e porte
  main/providers/store.ts          schema legato al catalogo
  renderer/src/app/settings/
    providers.ts                   scegli, incolla, fatto
```

---

### Task 1: Il catalogo, e la sua istantanea

**Files:**
- Create: `app/main/catalog/shape.ts`, `app/main/catalog/load.ts`, `app/scripts/fetch-catalog.mjs`, `app/catalog/snapshot.json.gz`, `app/test/catalog.test.ts`

- [ ] **Step 1: I test che falliscono**

Contro un'istantanea finta, non contro la rete:

- sfrondare tiene `npm`, `env`, `cost`, `limit` e le capacità, e butta il resto;
- l'istantanea inclusa si legge e si decomprime;
- una cache su disco più recente dell'istantanea vince;
- **una risposta di rete malformata non sostituisce ciò che funziona**: si tiene quello che c'è;
- **senza rete non è un errore**: si risponde con l'istantanea e si dichiara `stale: true`;
- un `304 Not Modified` non riscrive la cache.

- [ ] **Step 2: Eseguirli e verificare che falliscano**

- [ ] **Step 3: Implementare**

`fetch-catalog.mjs` scarica, sfronda e comprime — come `make-icons.mjs` per le icone: la forma è codice leggibile, non un binario committato senza provenienza.

A runtime: l'istantanea è il pavimento, la cache su disco è ciò che si è scaricato l'ultima volta, la rete si interroga **con ETag e in secondo piano**, mai sulla via critica dell'avvio. Un aggiornamento che fallisce non è un errore da mostrare: è un catalogo un po' vecchio, e lo si dice solo dove serve.

- [ ] **Step 4: Eseguire i test**
- [ ] **Step 5: Commit**

---

### Task 2: Chiedere all'endpoint cosa serve

**Files:**
- Create: `app/main/catalog/discover.ts`, `app/test/discover.test.ts`

**Interfaces:**

```ts
export interface Discovered { id: string; source: "endpoint" }
export function discoverModels(input: {
  baseUrl: string; apiKey: string | null; headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<Discovered[]>;
```

- [ ] **Step 1: I test che falliscono**

Con un server finto in-process, mai la rete vera:

- una risposta OpenAI (`{data: [{id: …}]}`) diventa un elenco di id;
- un `401` diventa un codice `unauthorized`, non una frase del provider;
- un endpoint irraggiungibile diventa `unreachable`;
- un JSON che non ha la forma attesa diventa `bad-response` e **non** un elenco vuoto: "nessun modello" e "non ho capito la risposta" sono fatti diversi;
- l'attesa ha un limite, o una porta sbagliata blocca la schermata per sempre.

- [ ] **Step 2–5**: come sopra.

I codici sono quelli che `VerifyOutcome` già usa, perché è già la lingua con cui questa applicazione parla dei provider.

---

### Task 3: Ollama e LM Studio

**Files:**
- Create: `app/main/catalog/local.ts`, `app/test/local.test.ts`
- Modify: `app/shared/channels.ts`, `app/main/ipc.ts`

**Interfaces:**

```ts
export interface LocalRuntime {
  id: "ollama" | "lmstudio";
  name: string;
  baseUrl: string;
  /** Ollama vuole una chiave e la ignora; LM Studio non ne vuole. */
  apiKey: string | null;
  models: string[];
}
export function probeLocalRuntimes(signal?: AbortSignal): Promise<LocalRuntime[]>;
```

- [ ] **Step 1: I test che falliscono**

- due server finti sulle due porte producono due runtime;
- una porta chiusa **non è un errore**: quel runtime semplicemente non c'è;
- la sonda ha un limite di attesa breve, perché gira mentre l'utente guarda;
- Ollama riceve `ollama` come chiave, LM Studio nessuna: è la differenza documentata fra i due;
- i modelli elencati sono quelli del server, **non quelli del catalogo** — `lmstudio` nel catalogo ne ha tre, e non sono i tuoi.

- [ ] **Step 2: Eseguirli e verificare che falliscano**

- [ ] **Step 3: Implementare**

Porte da configurare, con i valori noti come partenza: `11434` e `1234`. Chi ha cambiato porta lo deve poter dire.

- [ ] **Step 4: La verifica che i test non danno**

**Con un Ollama e un LM Studio davvero in esecuzione.** Le due righe su cui questo task si regge vengono dalla documentazione: nessuno dei due gira sulla macchina dove il piano è stato scritto. Finché non si è visto un elenco di modelli veri arrivare da un server vero, questo task non è fatto.

- [ ] **Step 5: Commit**

---

### Task 4: Lo store, legato al catalogo

**Files:**
- Modify: `app/main/providers/store.ts`, `app/shared/dto.ts`
- Create: `app/main/db/migrations/008-provider-catalog.sql`

- [ ] **Step 1: I test che falliscono**

- un provider ricorda **da quale voce di catalogo viene** (`catalogId`), così i suoi metadati si possono riaggiornare;
- un modello porta prezzo, contesto e capacità quando il catalogo li conosce, e `null` quando no;
- **aggiornare il catalogo non tocca la chiave né la scelta del modello**;
- un provider scritto a mano, senza `catalogId`, continua a funzionare: i preset esistenti non si rompono;
- il prezzo salvato è **quello del catalogo al momento**, con la sua data: se cambia, la stima di ieri resta spiegabile.

- [ ] **Step 2–5**: come sopra.

`PRESETS` sparisce come elenco scritto a mano. Resta un solo caso costruito a mano — l'endpoint compatibile generico — perché è la scorciatoia per ciò che il catalogo non conosce.

---

### Task 5: La schermata: scegli, incolla, fatto

**Files:**
- Modify: `app/renderer/src/app/settings/providers.ts` e il suo template
- Create: `app/renderer/src/app/settings/providers.spec.ts` (i casi nuovi)

- [ ] **Step 1: I test che falliscono**

Il flusso, e niente più di quello:

1. l'elenco dei provider si cerca scrivendo (203 voci non si scorrono);
2. i runtime locali trovati stanno **in cima**, marcati come locali e senza campo chiave;
3. scelto un provider, c'è **un solo campo**: la chiave;
4. incollata la chiave, i modelli compaiono da soli — l'utente non digita mai un id;
5. accanto a ogni modello ci sono prezzo e contesto, quando si sanno;
6. se la chiave è rifiutata lo dice **il catalogo delle frasi**, con il codice del Task 2;
7. il campo "endpoint compatibile" resta, dichiarato come la via per ciò che il catalogo non copre;
8. una riga dice da quando è il catalogo — il Task 6 le mette accanto i due pulsanti.

I test verificano anche ciò che **non** c'è più: nessun campo per digitare id di modelli, nomi visibili, contesto o prezzi a mano.

- [ ] **Step 2: Eseguirli e verificare che falliscano**

- [ ] **Step 3: Implementare**

La semplicità qui è sottrazione. Il modulo oggi ha `addModel`, `patchModel`, `removeModel` e cinque campi per modello: **spariscono**. Ciò che resta è una ricerca, una chiave, e un elenco che arriva.

- [ ] **Step 4–5**: come sopra.

---

### Task 6: Aggiornare il catalogo, e portarselo a mano

**Files:**
- Modify: `app/main/catalog/load.ts`, `app/shared/channels.ts`, `app/main/ipc.ts`,
  `app/renderer/src/app/settings/providers.ts` e il suo template
- Create: `app/test/catalog-update.test.ts`

**Interfaces:**

```ts
export interface CatalogState {
  /** Quando l'elenco che si sta usando è stato prodotto. */
  at: string;
  providers: number;
  models: number;
  /** Vero quando si sta usando l'istantanea inclusa e non un aggiornamento. */
  bundled: boolean;
}
"catalog.state":   { req: undefined; res: CatalogState };
"catalog.refresh": { req: undefined; res: CatalogState };
/** Installa un catalogo scelto da un file, per una macchina senza rete. */
"catalog.importFile": { req: undefined; res: CatalogState };
```

Un'applicazione che riceve il catalogo solo quando viene compilata invecchia
male: i modelli escono ogni settimana e i prezzi cambiano. E una macchina senza
rete non deve restare ferma all'istantanea per sempre — il file lo si può
portare su una chiavetta.

- [ ] **Step 1: I test che falliscono**

- un aggiornamento riuscito **sostituisce la cache e cambia la data**, e lo
  stato riporta quanti provider e quanti modelli sono arrivati;
- **un aggiornamento fallito non tocca niente**: si continua con quello che
  c'era, e lo si dice senza allarmare;
- un `304` lascia la cache dov'è e aggiorna solo il momento del controllo;
- la scrittura è **atomica** — file temporaneo e rinomina: un aggiornamento
  interrotto a metà non deve lasciare un catalogo troncato, che è peggio di uno
  vecchio;
- l'importazione da file **valida la forma prima di sostituire**: un JSON che
  non è un catalogo viene rifiutato con un codice, e ciò che funzionava resta;
- un catalogo importato più vecchio di quello in uso viene installato lo stesso,
  ma lo stato lo dichiara: è una scelta dell'utente, non un errore;
- `bundled` diventa falso appena si usa qualcosa che non è l'istantanea inclusa.

- [ ] **Step 2: Eseguirli e verificare che falliscano**

- [ ] **Step 3: Implementare**

Il file lo legge il processo main, come per i glossari: la finestra chiede, e
riceve indietro lo stato. Nessun percorso attraversa il confine.

Nella sezione Provider una riga sola dice **da quando è il catalogo**, con
accanto due azioni: aggiorna, e importa da file. Non un pannello: una riga e due
pulsanti, perché è informazione di servizio e non il motivo per cui si è aperta
quella schermata.

- [ ] **Step 4: Eseguire i test**
- [ ] **Step 5: Commit**

---

### Task 7: La stima mostra il denaro

**Files:**
- Modify: `app/renderer/src/app/new-project/new-project.ts`, `app/main/projects/detail.ts`, `app/main/report/build.ts`

- [ ] **Step 1: I test che falliscono**

- con un modello che dichiara i prezzi, la stima di un libro mostra un costo e non solo token;
- **senza prezzi mostra solo token**, come oggi: la regola non cambia, cambia che ora un prezzo esiste;
- il report calcola il costo dai token davvero spesi e dal prezzo del modello usato, e `run.cost` smette di essere sempre nullo.

- [ ] **Step 2–5**: come sopra.

È la parte che ripaga il piano: `estimate()` esiste dal piano 3, sa calcolare un costo, e **non le è mai arrivato un prezzo**.

---

### Task 8: Il pianificatore usa la finestra vera

**Files:**
- Modify: `core/translate/plan.ts`, `app/main/run/runtime.ts`

- [ ] **Step 1: I test che falliscono**

- un modello con una finestra piccola produce gruppi più piccoli;
- un modello con una finestra grande **non** produce gruppi illimitati: il tetto resta, perché un gruppo enorme peggiora la traduzione anche quando ci sta;
- senza un valore noto vale il numero di oggi, che resta il comportamento di riferimento.

- [ ] **Step 2–5**: come sopra.

Questo task cambia il comportamento della traduzione, non solo la configurazione. Se il tempo stringe, è il primo da rimandare — e in tal caso va **detto**, non lasciato a metà.

---

### Task 9: Dalla finestra vera

**Files:**
- Modify: `app/e2e/providers.spec.ts`

- [ ] **Step 1: Il test che fallisce**

Nella finestra vera, con un catalogo finto servito dal main:

1. si cerca un provider, lo si sceglie, si incolla una chiave, **i modelli compaiono**;
2. non esiste un campo in cui digitare l'id di un modello;
3. un runtime locale finto sulla sua porta compare fra i locali, **senza campo chiave**, con i modelli che quel server dichiara;
4. la chiave continua a non arrivare mai alla finestra: la lista risponde `hasKey`, e basta.

- [ ] **Step 2–5**: come sopra.

---

## Definizione di finito

- Aggiungere un provider sono tre gesti: cercarlo, sceglierlo, incollare la chiave.
- I modelli non si digitano mai.
- Ollama e LM Studio compaiono da soli quando sono in esecuzione, **verificato contro istanze vere**.
- Senza rete l'applicazione parte, mostra il catalogo incluso e lo dichiara vecchio senza allarmare.
- Il catalogo si aggiorna **quando lo chiede l'utente**, e su una macchina senza rete si importa da file. Un aggiornamento fallito o interrotto lascia intatto quello che funzionava.
- La stima di un libro mostra un costo quando il prezzo si sa, e solo token quando no.
- La chiave non compare in nessuna risposta IPC, come oggi.
- `core/` non ha imparato cos'è un provider.

## Cosa questo piano non dà

- **Nessun OAuth**: chi vuole Copilot o un abbonamento ChatGPT non passa di qui.
- **Nessuna verifica dei prezzi**: sono quelli che models.dev dichiara. Se sbaglia loro, sbagliamo noi — e per questo il prezzo mostrato porta la data del catalogo.
- **Nessuna scelta automatica del modello**: sceglie l'utente. Un'applicazione che decide da sola su cosa spendere è un'applicazione di cui ci si accorge dalla fattura.
- **Nessuna installazione di runtime locali**: li trova se ci sono, non li mette.
