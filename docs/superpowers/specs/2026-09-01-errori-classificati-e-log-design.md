# Errori classificati e log — design

**Data:** 2026-09-01
**Stato:** approvato in brainstorming, da tradurre in piano di implementazione

Il documento è in italiano perché in italiano è avvenuta la progettazione.
Codice e commenti restano in inglese.

## Contesto

Due difetti dichiarati, e sono lo stesso difetto visto da due lati.

Il primo: **i log ricalcano le fasi**. Il Registro racconta ciò che l'interfaccia
già mostra — una fase è iniziata, una fase è finita — e tace su tutto ciò che
accade dentro una fase. Se il provider rallenta, se la rete cade, se stiamo
ritentando, il Registro non lo dice, perché nessuno gliel'ha mai detto.

Il secondo: **gli errori non sono classificati**. Arrivano tutti sotto lo stesso
codice generico, lasciano l'applicazione in uno stato che nessuno ha descritto,
e non dicono cosa fare al passo successivo.

Sono lo stesso difetto perché la causa è una: il codice **conosce** ciò che
sarebbe utile dire e lo butta via prima di dirlo. `AnswerDiagnosis`
(`core/translate/engine.ts:26`) costruisce `finishReason`, `reasoningTokens` e
un estratto della risposta a **ogni** tentativo, e li conserva solo per il caso
in cui il terzo tentativo è già fallito. Il classificatore di errori non esiste
affatto, e al suo posto c'è una riga che legge un campo che non c'è.

### I tre difetti misurati sul codice

**1. Non esiste alcun ritentativo di rete.**
`sdkBackend` dichiara esplicitamente «no retry, no splitting, no fallback»
(`app/engine/backends/sdk.ts:88`), e il retry di `translateChunk`
(`core/translate/engine.ts:110`) conta soltanto le risposte *rifiutate dalla
validazione*. Se `backend.call()` **lancia** — 429, timeout, 500, chiave
scaduta, DNS — l'eccezione risale fino a `app/engine/main.ts:203` senza che
nessuno la guardi. Un singolo 429 a metà libro uccide la corsa intera.

**2. L'errore perde tutto tranne un codice che non ha.**

```ts
// app/engine/main.ts:41
function failureCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "ENGINE_FAILED";
}
```

Gli errori dell'AI SDK non hanno `.code`. Il risultato è `ENGINE_FAILED`,
sempre. Messaggio, causa, stato HTTP, fase, chunk: buttati. La finestra riceve
`{ type: "failed", code: "ENGINE_FAILED" }`, cerca `codes.ENGINE_FAILED` nel
catalogo, non lo trova, e stampa la stringa nuda sotto il titolo «La corsa si è
fermata».

Lo stesso accade nella composizione: `runtime.ts:190` legge di nuovo `.code`, e
`composeEpub` lancia `new Error("COMPOSE_NO_PACKAGE")` (`compose.ts:141`) e
`new Error("COMPOSE_NO_CACHE_KEY")` — `Error` nudi, senza `.code`. Con loro,
sotto la stessa parola `COMPOSE_FAILED`, arrivano il disco pieno di
`writeEpub`, il workspace spostato di `readFile`, e un `runEpubcheck` che non
parte. Quattro cause, una parola.

**3. Lo stato indefinito è reale, e ha un indirizzo.**

```ts
// core/translate/engine.ts:203
async function inParallel<T>(items: T[], limit: number, worker: …): Promise<void> {
  const queue = [...items];
  const running = Array.from({ length: … }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await worker(next);
    }
  });
  await Promise.all(running);
}
```

Se un worker lancia, `Promise.all` rigetta **subito** e gli altri worker
continuano a togliere chunk dalla coda: traduzioni scritte dopo che la corsa è
stata dichiarata fallita, token spesi dopo l'ultimo messaggio `usage`, righe
`run_event` su una corsa chiusa. Chi poi preme «riprendi» riparte da uno stato
che nessuno può descrivere, perché è ancora in movimento.

### Le tre decisioni prese in brainstorming

1. **Classificare e ritentare**, non solo classificare: la classe dell'errore
   deve autorizzare l'azione, altrimenti è un'etichetta.
2. **Due log separati**, più la possibilità di leggere il grezzo
   nell'interfaccia: il Registro resta curato, un file diagnostico prende
   tutto, e una vista dentro l'applicazione mostra il secondo.
3. **`paused` quando riprendere aiuterebbe, `failed` quando no.** È il taglio
   che dà senso alla tassonomia.

---

## Sezione 1 — La tassonomia

### La forma

`core/errors.ts` sostituisce `core/epub/errors.ts`. Il `code` resta ciò che è
già — stabile, specifico, senza una parola per il lettore — e accanto nasce il
`fault`, che non descrive: **autorizza**.

```ts
export type Fault =
  | "transient"   // ritentare aiuta, e subito
  | "throttled"   // ritentare aiuta, ma quando lo dice il provider
  | "exhausted"   // ritentare oggi non aiuta
  | "config"      // deve cambiare qualcosa chi usa l'applicazione
  | "input"       // il libro non si presta
  | "refused"     // il gate ha rifiutato ciò che abbiamo composto
  | "defect"      // una nostra invariante si è rotta
  | "cancelled";  // pausa o annullamento: non è un errore, ma viaggia sulla stessa strada

export class BabelError extends Error {
  readonly code: string;
  readonly fault: Fault;
  /** Scalari soltanto: sono i soli che attraversano `packFailure`. */
  readonly detail: Record<string, string | number | boolean>;
  /** Solo su `throttled`, e solo quando il provider l'ha detto davvero. */
  readonly retryAfterMs?: number;
}
```

`EpubReadError`, `EpubWriteError`, `ScanError` e `ProviderStoreError` perdono la
classe propria e diventano casi di questo, con un `fault`.

### La tabella è la specifica

Non c'è un secondo posto dove si decide. Ogni classe risponde a tre domande, e
il codice le legge da qui.

| `fault` | si ritenta? | stato dopo l'ultimo tentativo | chi deve agire |
|---|---|---|---|
| `transient` | sì, backoff esponenziale | `paused` | nessuno; poi la persona |
| `throttled` | sì, all'ora che dice il provider | `paused` | nessuno |
| `exhausted` | no | `paused` | la persona: ricaricare credito |
| `config` | no | `paused` | la persona: impostazioni |
| `input` | no | `failed` | la persona: un altro file |
| `refused` | no | `failed` | la persona: leggere il report |
| `defect` | no | `failed` | noi: il file diagnostico |
| `cancelled` | no | `paused` | — |

**`failed` significa «riprendere non lo aggiusterebbe»**, e resta solo per le
tre classi in cui è vero. Oggi ci finisce anche una rete caduta, e il badge
dice «Rifiutato» di un libro che nessuno ha rifiutato.

La tabella esiste nel codice come due costanti esportate da `core/errors.ts`
accanto a `Fault` — `RETRIES_ON` e `PAUSES_ON`, `Record<Fault, boolean>` — e
sono le sole due letture ammesse. Un `if` sul `fault` scritto altrove è una
seconda tabella, ed è la seconda tabella a divergere.

`cancelled` non nasce mai da un errore classificato: `app/engine/main.ts:207`
non emette nulla quando il segnale è abortito, e la pausa arriva dal gesto della
persona per la sua strada. La riga esiste perché una pausa e un errore
attraversano lo stesso `catch`, e senza una classe per il primo il secondo se lo
mangerebbe.

### Dove si classifica

Non nel core: il core non sa cosa sia un 429, e se lo sapesse smetterebbe di
essere il core. Si classifica ai bordi, in moduli che sono ciascuno l'unico a
conoscere la forma degli errori di cui parla.

| modulo | conosce |
|---|---|
| `app/engine/backends/classify.ts` (nuovo) | `APICallError` dell'SDK: `statusCode`, `responseHeaders`, `isRetryable`. Distingue un 429 di rate-limit da un 429 di credito finito, un 401 da un 404-modello-inesistente. |
| `app/main/failure.ts` (nuovo) | `ENOENT`, `EACCES`, `ENOSPC`, gli errori di `node:sqlite`. |
| il core | i propri: lancia già `BabelError` di suo. |

### I codici

Non è un elenco chiuso — il ripiego sul `fault` (sezione 5) è ciò che rende
lecito aggiungerne senza catalogarli subito. Questi sono quelli che il piano
deve produrre:

`PROVIDER_UNREACHABLE` · `PROVIDER_TIMEOUT` · `PROVIDER_RATE_LIMITED` ·
`PROVIDER_OUT_OF_CREDIT` · `PROVIDER_UNAUTHORIZED` · `PROVIDER_SERVER_ERROR` ·
`MODEL_NOT_FOUND` · `CONTEXT_EXCEEDED` · `RESPONSE_UNUSABLE` ·
`SOURCE_MISSING` · `DISK_FULL` · `COMPOSE_NO_PACKAGE` · `COMPOSE_NO_CACHE_KEY` ·
`GATE_REFUSED` · `ENGINE_BUSY` · `GATE_OPEN` · `NO_LANGUAGE` · `SOURCE_CHANGED`

### La regola di sicurezza

`detail` è una **lista permessa**, mai l'errore grezzo. Gli errori dell'SDK
portano dentro la richiesta che li ha causati — quindi gli header, quindi la
chiave API. Il README promette che la chiave «non arriva mai alla finestra»: un
errore ricopiato per intero dentro un `detail` o dentro un record di log è
esattamente il modo in cui quella promessa si rompe senza che nessuno se ne
accorga. Il classificatore estrae i campi che nomina e butta il resto.

Il filtro a scalari già presente in `packFailure` (`app/shared/dto.ts:532`)
resta, ed è la seconda rete della stessa regola.

### Le modifiche

- `core/errors.ts` nuovo; `core/epub/errors.ts` rimosso, i suoi tipi riesportati
  da `core/epub/index.ts` come casi di `BabelError` finché i chiamanti non sono
  aggiornati.
- `packFailure` / `IpcFailure` (`app/shared/dto.ts:519-542`): due campi in più,
  `fault` e `retryAfterMs`. È questo che permette a **ogni** schermata, non solo
  alla corsa, di dire cosa fare dopo.
- `app/engine/backends/classify.ts`, `app/main/failure.ts` nuovi.

---

## Sezione 2 — Il ritentativo

### La forma

Un terzo decoratore, `core/translate/retry.ts`, sorella di `usage.ts` e con la
stessa forma:

```ts
export interface RetryPolicy {
  maxAttempts: number;  // 5
  baseMs: number;       // 1000
  maxMs: number;        // 60_000
}

export function retryingBackend(inner: LlmBackend, deps: {
  classify(error: unknown): BabelError;
  log: LogSink;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;  // iniettato: i test non aspettano
  policy?: Partial<RetryPolicy>;
}): LlmBackend;
```

**Cinque tentativi**, base 1s, tetto 60s, esponenziale con jitter. `throttled`
non indovina: se il provider ha detto `Retry-After`, aspetta quello, limato al
tetto. Il segnale di annullamento è controllato prima della chiamata e **durante
l'attesa** — una pausa non deve aspettare sessanta secondi per farsi sentire.
Un errore che non è `transient` né `throttled` viene rilanciato senza attesa.

Il core resta il core: `classify` entra come funzione.

### Il montaggio

In `runProject` (`app/main/run/orchestrator.ts:87`), una riga sopra quella che
c'è già:

```ts
const backend = retryingBackend(countingBackend(deps.backend, …), { classify, log, sleep });
```

Conteggio all'interno, ritentativo all'esterno: `countingBackend` conta le
chiamate vere a cui il provider ha davvero risposto, e le tre fasi che parlano
al modello — `candidates`, `code-index`, `translate` — ereditano il ritentativo
senza che nessuna se lo debba ricordare. È lo stesso argomento con cui
`countingBackend` è finito lì.

### Perché il divieto in `sdk.ts` resta onorato

Il commento di `app/engine/backends/sdk.ts:88` vieta di nascondere ritentativi
*sotto* il motore, dove si moltiplicherebbero con i suoi. Qui non si
moltiplicano: i tre tentativi di `translateChunk` contano le **risposte
rifiutate dalla validazione**, questi contano le **chiamate che non hanno
prodotto risposta**. Un errore di trasporto non è mai stato un tentativo di
validazione. Il tetto peggiore diventa 3 × 5 = 15 chiamate per chunk, ed è un
numero che si può dire in anticipo — che è la sola cosa che quel divieto
proteggeva.

### Due difetti adiacenti da correggere qui

**2A — `countingBackend` perde `structured`, e il contratto a schema non è mai
in uso.**

```ts
// core/translate/usage.ts:20
export function countingBackend(inner: LlmBackend, onUsage: …): LlmBackend {
  return { async call(input) { … } };   // `structured` non è inoltrato
}
```

`orchestrator.ts:87` è il suo unico chiamante di produzione, e avvolge il
backend che tutte le fasi poi usano. Quindi in `translateChunk`
(`core/translate/engine.ts:118`) `input.backend.structured` è `undefined` —
sempre. **Ogni corsa passa dal contratto testuale**, anche sui modelli che
reggono lo schema, e anche quando `BackendSpec.structured` è vero e ha già
partecipato alla chiave di cache. Nessun test copre la proprietà sul
decoratore, il che è il motivo per cui è sopravvissuto.

Va corretto qui perché aggiungendo un secondo decoratore nella stessa posizione
si incapperebbe nella stessa trappola: **entrambi devono inoltrare
`structured`**, e serve un test che lo asserisca sul decoratore, non solo sul
backend.

**2B — `inParallel` non ferma gli altri worker.** La correzione sta dentro
`inParallel`: un `AbortController` condiviso che il primo errore abortisce, i
worker che controllano il segnale prima di togliere il chunk successivo,
`Promise.allSettled` per aspettare che tutti abbiano davvero smesso, e poi il
rilancio del primo errore che non sia `cancelled`. Il lavoro già scritto resta:
ogni unità è scritta prima del chunk successivo, e questo non cambia.

Con 2A e 2B, «riprendi» dopo un errore riparte da uno stato descrivibile:
quello che c'è nello store, e niente che stia ancora arrivando.

### Le modifiche

- `core/translate/retry.ts` nuovo.
- `core/translate/usage.ts`: inoltra `structured`.
- `core/translate/engine.ts`: `inParallel` con abort condiviso.
- `app/main/run/orchestrator.ts:87`: il montaggio.

---

## Sezione 3 — I due log

### La forma

Una porta in `core/ports.ts`, sorella di `ProgressSink`:

```ts
export interface LogRecord {
  level: "debug" | "info" | "warn" | "error";
  code: string;                                    // stesso vocabolario stabile di RunEvent
  detail?: Record<string, string | number | boolean>;
}

export interface LogSink { record(entry: LogRecord): void; }
```

**Un asse solo, il livello**, e la regola che ne discende è una riga: `debug` va
solo nel file diagnostico; `info`, `warn` ed `error` vanno in entrambi. Non
serve un secondo campo «pubblico»: il livello lo dice già.

### Rapporto con `store.event`, che esiste già

Restano due cose diverse. `RunEvent` con `severity: "degradation"`
(`core/ports.ts:44`) è un **verdetto sul libro** — è ciò che abbassa un libro a
`incomplete` e finisce nel report. `LogSink` è la **cronaca della corsa**.

L'implementazione del sink lato host scrive comunque le righe `info+` dentro
`run_event`, quindi il Registro continua a leggere da un solo posto e `runLog`
(`app/main/run/log.ts`) non cambia forma: gli basta che la sua mappa
`SEVERITIES` conosca anche `warn`.

### Il file

`workspace.root/logs/run-<runId>.<processo>.ndjson`, una riga JSON per record:

```json
{"at":"…","level":"warn","code":"provider-retry","process":"engine",
 "projectId":"…","runId":"…","phase":"translate","attempt":2,"max":5,"waitMs":4000,
 "reason":"PROVIDER_RATE_LIMITED"}
```

Due file perché due processi, uniti alla lettura per timestamp — che è
precisamente il mestiere che `runLog` fa già con le sue due sorgenti. Il motore
scrive il proprio direttamente, **senza passare dal `MessagePort`**: è lì il
punto, migliaia di righe `debug` non devono attraversare un porto pensato per i
comandi.

Conservazione: le ultime **5 corse per progetto**; le più vecchie cancellate
all'avvio di una corsa nuova.

**Fuori da una corsa** — verificare un provider, aggiornare il catalogo, aprire
il database all'avvio — non c'è né un `runId` né un workspace, e `run_event`
esige entrambi. Quei record vanno in un solo file d'applicazione,
`app.getPath("userData")/logs/app.ndjson`, ruotato a dimensione (2 MB, un
ricambio). Non finiscono in nessun Registro: il Registro è di un libro, e quelle
cose non appartengono a nessun libro. La schermata che ha fallito lo dice per
conto suo, con `tell()`.

### Cosa finisce dove

Nel **Registro** (`info` / `warn` / `error`):

| codice | livello | quando |
|---|---|---|
| `provider-retry` | warn | tentativo *n* di 5, fra *x* secondi, e perché |
| `provider-recovered` | info | ha ripreso dopo *n* tentativi — altrimenti la storia resta appesa |
| `provider-slow` | info | una chiamata oltre **30 s** (costante in `retry.ts`): non è rotto, è lento |
| `run-paused` | warn | con `fault` e `code`: perché la corsa si è fermata |
| `chunk-failed` | warn | un gruppo perso per intero, con quante unità |
| `unit-fell-back` | warn | esiste già, resta |

Nel **file diagnostico** soltanto (`debug`):

- ogni chiamata al modello: fase, chunk, unità, caratteri, token, durata,
  `finishReason`, `reasoningTokens`;
- ogni rifiuto di validazione, con codice ed estratto;
- ogni transizione della macchina e ogni stato scritto;
- l'errore grezzo classificato con lo stack, **passato dalla lista permessa
  della sezione 1**, mai copiato intero.

### Il costo, e perché lo si paga

`LogSink` deve arrivare dove le cose accadono: `translateChunk`,
`translateUnits`, `extractCandidates`, `indexCodeBlocks`, `composeEpub`. Sono
tutte funzioni che prendono già un oggetto di opzioni, quindi è un campo in più
su ciascuna, opzionale, con un sink muto come default — così i 975 test
esistenti non vanno toccati tutti.

Non si mette un logger globale a livello di modulo, anche se costerebbe meno:
`ports.ts` dichiara che il core «dichiara queste interfacce e riceve
implementazioni», ed è la ragione per cui ogni fase è provabile in memoria. Un
logger ambientale sarebbe la prima dipendenza nascosta, e la seconda arriverebbe
più facilmente.

### Il guadagno collaterale

Un `LogSink` dentro `translateChunk` rende finalmente osservabile la diagnosi
che il motore già costruisce e poi butta. `AnswerDiagnosis`
(`core/translate/engine.ts:26`) oggi sopravvive solo dentro `unit-fell-back`,
cioè solo quando è già troppo tardi. Con il sink si vede al **primo** rifiuto,
non al terzo.

### Le modifiche

- `core/ports.ts`: `LogRecord`, `LogSink`, e un `nullSink`.
- `app/main/run/diagnostics.ts` (nuovo): lo scrittore NDJSON, la rotazione, la
  lettura unita.
- I cinque punti di chiamata sopra elencati.
- `app/main/run/log.ts`: `SEVERITIES` conosce `warn`.

---

## Sezione 4 — La macchina e il runtime

### La macchina cambia di una riga

```ts
| { type: "PAUSE"; reason?: string }
```

Nient'altro. La ragione **non** entra in `ProjectContext`: `project_state.info`
è già dove il ramo `failed` scrive la sua (`runtime.ts:200`), e due posti che
ricordano la stessa cosa sono due posti che possono contraddirsi. La macchina
resta ciò che dichiara di essere — dice cosa è lecito, non cosa è successo.

### Il runtime: un tavolo di traduzione, non otto `if`

`EngineMessage` porta la classe fino a casa:

```ts
| { type: "failed"; code: string; fault: Fault; detail?: …; retryAfterMs?: number }
```

e in `onEngineMessage` la tabella della sezione 1 diventa l'unica decisione:

```ts
const ending = PAUSES_ON[message.fault] ? "paused" : "failed";
leaveState(db, { projectId, kind: "phase", outcome: ending, info: { code, fault } });
host.send(ending === "paused"
  ? { type: "PAUSE", reason: message.code }
  : { type: "FAIL", reason: message.code });
```

### I cinque punti dove l'informazione si perde

**4A — `app/engine/main.ts:41`, `failureCode()`.** Diventa il classificatore
della sezione 1, che di un errore ignoto fa comunque un `defect` con codice e
stack nel file diagnostico.

**4B — `app/engine/main.ts:207`, `if (!signal.aborted)`.** Giusto per una pausa
voluta, ma ingoia anche un errore vero che capiti a cavallo dell'abort. Resta
com'è — non si trasforma una pausa in un fallimento — ma **l'errore ingoiato va
scritto nel file diagnostico** invece di sparire.

**4C — `runtime.ts:190`, la composizione.** È alla lettera «un errore nella
composizione non indica cosa è capitato realmente». Le quattro cause del
Contesto prendono un codice proprio; `readFile` e `writeFile` passano da
`app/main/failure.ts` — `ENOSPC` → `DISK_FULL`/`config`, `ENOENT` sulla sorgente
→ `SOURCE_MISSING`/`input`. `GATE_REFUSED` prende `fault: "refused"` e resta
`failed`, che è giusto: ricomporre uguale non lo aggiusterebbe.

**4D — `RunRefusedError`** (`runtime.ts:78`) ha già il codice, gli manca la
classe. `ENGINE_BUSY`, `GATE_OPEN`, `NO_LANGUAGE`, `SOURCE_CHANGED` sono tutti
`config`: qualcosa deve cambiare prima di riprovare, e ora la schermata può dire
cosa.

**4E — Lo stato che resta appeso.** `runtime.ts` tiene tre variabili —
`activeId`, `activeRunId`, `activeComposition` — e ogni finale ne azzera un
sottoinsieme diverso: il ramo `failed` lascia `activeRunId`, il ramo `done`
pure. Nessuna di queste è oggi un difetto visibile, perché `onEngineMessage`
esce subito quando `activeId` è nullo. Ma sono tre variabili che significano una
cosa sola — «chi possiede il motore adesso» — e l'unico modo perché non
divergano è che si azzerino insieme. Diventano un `release()` chiamato da tutti
i finali.

### Un'incoerenza minore nello stesso punto

`pause()` e `onCrash()` scrivono `leaveState(…, "paused")` senza guardare se la
macchina ha accettato il `PAUSE` — e un progetto già in pausa lo rifiuta, perché
`paused` non ha una transizione su sé stesso. Si scrive uno stato che la
macchina non ha vissuto. `leaveState` va **dopo** il `send`, e solo se ha
accettato.

### Le modifiche

- `core/workflow/project.machine.ts`: `PAUSE` con `reason`.
- `app/shared/run.ts`: `EngineMessage.failed` arricchito.
- `app/main/run/runtime.ts`: il tavolo, `release()`, l'ordine `send` →
  `leaveState`.
- `app/engine/main.ts`, `app/main/compose.ts`: i codici propri.
- Il DTO della fase porta anche il `fault`.

---

## Sezione 5 — L'interfaccia

### Un solo posto che trasforma un errore in una frase

`app/renderer/src/app/core/failure.ts`:

```ts
export interface Told { body: string; hint: string | null; code: string; }
export function tell(transloco: TranslocoService, failure: IpcFailure): Told;
```

**Il titolo non è affare di `tell()`.** Ogni schermata ne ha già uno buono e
giusto per sé — `alerts.failed`, `providers.findFailed`, `glossaries.failed` — e
sostituirli con una frase generica sarebbe un peggioramento travestito da
uniformità. `tell()` produce ciò che oggi manca: il corpo, il suggerimento, e il
codice grezzo da mostrare in piccolo.

La ricerca è a due livelli, e il secondo è il motivo per cui il `fault` esiste:
**prima `codes.<CODE>`, poi `faults.<fault>`.**

Oggi un codice non catalogato si stampa nudo (`side.ts:246`): un identificatore
in mezzo a una frase italiana. Con il ripiego, il caso peggiore diventa *«Il
provider non ha risposto. Riprovare fra poco può bastare.»* con il codice grezzo
in piccolo — un pavimento invece di un buco. Ed è ciò che rende la tassonomia
utile anche per gli errori che non abbiamo previsto, che sono quelli che
contano.

`hint` è la risposta a «cosa faccio adesso», presa dal `fault` e non dal codice:
otto frasi, scritte una volta.

### Il cartellino d'allarme

`alerts.failed` = «La corsa si è fermata» diventa due cartellini, perché ora ci
sono due finali:

- corsa in **pausa** con una ragione → tono `warning`, corpo dal `tell()`, e
  l'azione giusta è il pulsante *Riprendi* che c'è già: il cartellino lo dice
  invece di aggiungerne un altro;
- corsa **fallita** → tono `danger`, e per `config` ed `exhausted` un pulsante
  che porta a *Impostazioni → Provider* del progetto, perché è lì che si
  aggiusta.

`side.ts:152 #failureCode()` cerca oggi solo `phases.find(e => e.state ===
"failed")`. Con questo design una corsa fermata da un 429 finisce in `paused`
con un codice: la ricerca diventa «l'ultima fase chiusa che porta un codice»,
qualunque sia l'esito.

### Il Registro, e una correzione perché le righe nuove si vedano

`phrase()` (`side.ts:232`) chiama `#sentence(key, fallback)` **senza passare
parametri**, quindi una voce di catalogo con segnaposti resterebbe con i `{{ }}`
dentro. Deve passare `line.info`. Solo così

```
codes.provider-retry = Tentativo {{attempt}} di {{max}} fra {{seconds}} s — {{reason}}
```

dice qualcosa.

### Il grezzo, accanto e non sopra

Il grezzo **non** diventa una terza scheda: le due schede sono cose che si
guardano ogni giorno, il log grezzo è quello che si apre una volta. Sta dentro
la scheda Registro, dietro un interruttore `Registro | Grezzo`.

In *Grezzo*: monospaziato, le righe NDJSON unite dai due file per timestamp,
chip di filtro per livello (`debug` spento di default), e due pulsanti — *copia*
e *apri cartella*.

Un'invocazione IPC nuova, `run.diagnostics`, che risponde con le ultime **2000
righe** e il percorso. Lo strozzatore `#soon()` che il pannello ha già
(`side.ts:262`) vale anche per questa.

### Le schermate che oggi falliscono in silenzio

`providers.findFailed`, `providers.failed`, `providers.catalogRefreshFailed`,
`glossaries.failed`, `prefs.failed`: tengono il loro titolo e guadagnano il
corpo da `tell()`. In concreto, «Non è stato possibile chiedere l'elenco dei
modelli» diventa *«La chiave non è stata accettata»* oppure *«L'endpoint non
risponde»* — che è la differenza fra due pomeriggi molto diversi, ed è il punto
in cui un errore di rete arriva per primo, prima di aver speso qualcosa.

### Le modifiche

- `app/renderer/src/app/core/failure.ts` nuovo.
- `app/locales/it.json` e `en.json`: gli otto `faults.*` (frase e
  suggerimento), `alerts.paused` accanto ad `alerts.failed`, i `codes.*` della
  sezione 1, i sei codici di log della sezione 3.
- `app/renderer/src/app/project/side/side.ts` e `side.html`: i due cartellini,
  `phrase()` con i parametri, l'interruttore e la vista grezza.
- `app/shared/channels.ts`, `app/main/ipc.ts`: `run.diagnostics`.
- Le schermate dei provider, del catalogo, dei glossari e delle preferenze.

---

## Cosa questo documento non affronta

- **Nessun sistema di toast, nessun centro notifiche, nessun pulsante «riprova»
  sparso per ogni schermata.** Il cartellino, il Registro e la vista grezza
  bastano.
- **Nessuna ripresa automatica.** Una corsa in pausa per una rete caduta resta
  in pausa finché qualcuno preme «riprendi». Riprendere da soli significa
  spendere senza che nessuno guardi, contro il principio del README.
- **Nessuna telemetria, nessun invio del file diagnostico da nessuna parte.**
  Il file sta nel workspace; copiarlo è un gesto della persona.
- **Nessun `Result<T, E>` al posto delle eccezioni.** È la soluzione corretta in
  astratto ed è un rifacimento di tutto il core per un problema che si risolve
  senza.
- **Il ritentativo non si applica alla composizione.** Ricomporre è già un gesto
  che l'interfaccia offre, e non ha senso automatizzarlo su un disco pieno.

## Le migrazioni

**Nessuna.** `run_event.severity` è `TEXT` senza vincolo `CHECK`
(`001-initial.sql:196`), quindi `warn` ed `error` si scrivono senza toccare lo
schema; `project_state.info_json` esiste già ed è dove il `fault` va a stare. Il
file diagnostico non è nel database.

## Come si prova

**core**

- `retryingBackend` con un backend che lancia a comando e un `sleep` iniettato:
  backoff esponenziale, tetto a 60s, `Retry-After` onorato, abort **durante**
  l'attesa, un errore non ritentabile rilanciato senza attese.
- Entrambi i decoratori inoltrano `structured` (il difetto 2A) — asserito sul
  decoratore, non sul backend.
- `inParallel`: al primo errore gli altri worker smettono davvero, nessuna
  scrittura arriva dopo il rilancio, e l'errore rilanciato è il primo che non
  sia `cancelled`.

**classificazione**

- Una tabella di errori SDK reali → `fault` atteso, per ciascuno dei codici
  della sezione 1.
- **La chiave API non compare in `detail`, né in un `LogRecord`, né nel file
  NDJSON** — partendo da un errore SDK che la contiene davvero.

**app**

- `runtime` manda `PAUSE` su `exhausted` e `FAIL` su `refused`, e scrive il
  `fault` in `project_state.info`.
- `composeEpub` distingue disco pieno, sorgente mancante e package mancante.
- Il sink scrive `info+` in `run_event` e tutto nel file; la rotazione tiene 5
  corse.
- `release()`: dopo ogni finale le tre variabili sono nulle insieme.

**renderer**

- `tell()` ripiega su `faults.<fault>` quando il codice non è catalogato.
- `phrase()` interpola i parametri di `line.info`.
- I due cartellini, con il pulsante verso le impostazioni solo per `config` ed
  `exhausted`.

**end-to-end**

- Un provider che risponde 429 due volte e poi funziona: la corsa arriva in
  fondo, e il Registro racconta i due tentativi e la ripresa.
- Un provider che risponde 429 per sempre: il progetto finisce in **pausa**, con
  la ragione scritta e leggibile, e «riprendi» riparte senza ritradurre ciò che
  era già fatto.
