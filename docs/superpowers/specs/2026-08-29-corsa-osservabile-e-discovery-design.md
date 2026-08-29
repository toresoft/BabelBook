# La corsa osservabile e il discovery — design

**Data:** 2026-08-29
**Stato:** approvato in brainstorming, da tradurre in piano di implementazione

Il documento è in italiano perché in italiano è avvenuta la progettazione.
Codice e commenti restano in inglese.

## Contesto

Cinque difetti, segnalati dopo aver fatto girare l'applicazione su un libro
vero con un provider vero — la prova che `STATO.md` chiama da sempre «il rischio
numero uno», e che nessuna delle 574 suite poteva dare.

Sono cinque, ma non sono indipendenti. Tre di essi — la barra ferma, i token
fermi, il discovery peggiorato — sono la stessa mezz'ora di orologio guardata da
tre finestre diverse: il passaggio `code-index` interroga il modello 298 volte
di fila, in sequenza, con la domanda sbagliata, senza dire a nessuno che sta
succedendo e senza registrare ciò che spende.

I numeri di questo documento sono misurati sul libro *Total TypeScript — The
Essentials*, estratto con il codice attuale di `core/epub/blocks.ts`.

```
7199 unità totali · 5951 translate · 1248 code
  di cui code:  1147 block  +  101 attribute
  unità block il cui testo mostrato è vuoto: 1147 su 1147
  run di unità code consecutive:  1 → 1046 volte,  2 → 101 volte
```

## Sezione 1 — La barra

### Il difetto

`Progress` porta già la fase (`core/ports.ts:87`), e l'orchestratore la butta
via nel tradurla in messaggio:

```ts
// app/main/run/orchestrator.ts:165
report(progress): void {
  emit({ type: "progress", done: progress.done, total: progress.total });
}
```

Ma il difetto vero sta più a monte: `progress.report` viene chiamato **solo**
da `translateUnits` (`core/translate/engine.ts:239`). `extractCandidates` e
`indexCodeBlocks` non ricevono nemmeno un `ProgressSink`. Su questo libro il
code-index fa 5951 ÷ 20 = **298 chiamate strettamente sequenziali** prima che la
prima riga sia tradotta, e per tutta la loro durata non arriva un solo
messaggio. Poi, dentro la traduzione, la barra si muove solo quando un chunk
intero atterra.

### La forma

La schermata oggi confonde due domande in una barra sola:

- **quanto del libro è tradotto** — un fatto del database, monotono,
  sopravvive a un riavvio, ha senso anche a corsa spenta;
- **cosa sta facendo adesso** — un fatto della corsa, esiste solo mentre corre,
  e riparte a ogni fase.

Sono due cose. La barra attuale è la prima, ma si muove soltanto durante
l'ultima fase della seconda: fuori di lì è, correttamente, immobile — e
immobile è esattamente ciò che non si capisce.

**Restano due, e si vedono come due.** La copertina in libreria porta la prima.
La schermata del progetto porta la prima e, mentre la corsa è viva, la seconda
sotto: il nome della fase e il suo contatore.

### Dove un totale non esiste

Una fase che non sa quanto durerà ottiene una barra indeterminata. La regola e
la frase esistono già in questo repository, sullo splash:

```
/* A bar that moves without claiming progress: nothing here knows how far
   along the start is, and a bar that filled up would be inventing it. */
```

### Le modifiche

- `EngineMessage.progress` porta anche `phase` (`app/shared/run.ts:88`), e
  `engine-host.ts:47` la valida come valore di `Progress["phase"]`.
- `extractCandidates` e `indexCodeBlocks` accettano un `ProgressSink`
  opzionale. Entrambe sono contabili: la prima cicla su `sampleBlocks` (tre
  campioni), la seconda sui batch.
- Il canale `run.progress` porta la fase; il renderer tiene un segnale
  `phaseProgress` separato da `project.progress`.
- La fase si azzera quando la corsa finisce o si ferma: una barra di fase
  rimasta sullo schermo a corsa spenta è una bugia con una data.

## Sezione 2 — I token

### Il difetto

Peggiore di «fermo». `run.tokens_in` è scritto **una volta sola**, sul
messaggio `done` (`app/main/run/runtime.ts:193`), e `project.detail` somma
quella colonna. Ma il conto stesso è parziale in due modi:

1. `translateUnits` somma solo i token della **propria** fase. Candidates e
   code-index chiamano il modello e nessuno conta.
2. `stoppedSummary` restituisce `tokensIn: 0, tokensOut: 0`
   (`app/main/run/orchestrator.ts:47`). Una corsa che si ferma al gate dei
   termini o a quello delle esclusioni **registra costo zero** avendo pagato
   tutto ciò che l'ha portata fin lì — su questo libro, 3 campioni più 298
   batch.

### La forma

Un contatore per corsa, non per fase. Un decoratore attorno a `LlmBackend`,
messo **una volta** nell'orchestratore:

```ts
function countingBackend(inner: LlmBackend, onUsage: (usage: Usage) => void): LlmBackend
```

La ragione di questa forma e non di un parametro per fase: una fase futura che
chiama il modello viene contata senza che nessuno se lo ricordi. Il conto per
fase è dimenticabile; il decoratore no.

`RunSummary.tokensIn/out` viene riempito dal contatore in entrambi i rami —
quello che traduce e quello che si ferma a un gate. Il conto di `translateUnits`
resta dov'è, perché è ciò che il report attribuisce alla traduzione, ma non è
più l'unico.

### I token di ragionamento

`LlmResult.reasoningTokens` esiste già. Va conservato: è il numero che spiega
una risposta vuota pagata piena, ed è la ragione per cui `routeDefaults`
disabilita il ragionamento su DeepSeek (`app/main/providers/store.ts:286`).

Migrazione **009**: `ALTER TABLE run ADD COLUMN reasoning_tokens INTEGER NOT
NULL DEFAULT 0`.

### Le modifiche

- Nuovo `EngineMessage`: `{ type: "usage"; tokensIn; tokensOut; reasoningTokens }`,
  emesso dopo ogni chiamata. Sono ordini di grandezza di centinaia di messaggi
  per corsa, non di migliaia: una chiamata dura secondi.
- Il main accumula e scrive su `run` a ogni messaggio, e trasmette
  `run.usage` al renderer.
- Il costo si ricalcola con i prezzi già letti da `modelPricesOf`, così la
  cifra in euro sale insieme ai token invece di apparire alla fine.

## Sezione 3 — Il ragionamento, per modello

### Il difetto

Nessun controllo. Esiste un solo caso, cablato:

```ts
// app/main/providers/store.ts:292
if (route === "deepseek") return { deepseek: { thinking: { type: "disabled" } } };
```

Il commento sopra spiega perché non è una preferenza ma un fatto: il
ragionamento acceso brucia l'intero budget di output, il chunk torna vuoto con
`finishReason: "length"`, ogni unità cade in fallback, e la chiamata è fatturata
piena. Quel fatto vale per ogni modello che ragiona, non per una rotta sola.

### La forma

Il catalogo dichiara già la capacità: `provider_model.capabilities`
(migrazione 008) porta `reasoning: boolean` (`app/main/catalog/shape.ts:36`).

Migrazione **009**: `ALTER TABLE provider_model ADD COLUMN reasoning_enabled
INTEGER` — annullabile, e `NULL` significa «il default della rotta», che è
quello che `routeDefaults` fa oggi.

**L'interruttore compare nella riga del modello solo se il catalogo dichiara
che quel modello sa ragionare.** Un interruttore su un modello che non ragiona
è un comando che non fa niente, e un comando che non fa niente insegna a non
fidarsi degli altri.

Spento come default dell'applicazione. Non per gusto: per la ragione già
scritta nel commento di `store.ts`, che vale per la traduzione in generale — un
libro non si traduce meglio pensandoci di più, e si traduce peggio se il
pensiero mangia il budget della risposta.

### La mappatura per rotta

Ogni rotta lo scrive diversamente: `thinking` per Anthropic e DeepSeek,
`reasoningEffort` per OpenAI, `thinkingConfig` per Google. Quella tabella sta in
**un posto solo**, accanto a `routeDefaults`, e ha la stessa natura: fatti su
come questa applicazione deve chiamare la rotta, non su cosa la rotta serve —
per questo non stanno in nessun catalogo.

Le opzioni risolte per il modello si compongono così, in ordine:
`routeDefaults(route)` → la scelta per modello, quando non è `NULL`.

### La conseguenza sulla chiave di cache

**La scelta entra nella chiave.** `CacheKeyInput` prende un campo `reasoning:
boolean`, risolto (cioè con il default della rotta già applicato).

La regola è quella già scritta in `core/translate/versions.ts`: ciò che cambia
il modo in cui la risposta è stata prodotta fa parte dell'identità del lavoro.
Un libro metà tradotto col ragionamento acceso e metà spento non è un
risparmio: è una mescolanza, con la stessa parola usata in
`app/main/run/cache-key.ts` per il modello.

Il prezzo va dichiarato: **cambiare l'interruttore invalida le traduzioni già
fatte con quel modello.** La schermata deve dirlo prima di farlo, e il modo di
dirlo esiste già — `app/main/terms/invalidate.ts` calcola e dichiara cosa
disferebbe prima di disfarlo, ed è il modello da seguire.

`projectCacheKey` (`app/main/run/cache-key.ts`) è il posto dove il valore si
legge: è già l'unico che sa dove stanno in tabella le parti della chiave, e
`reasoning_enabled` del modello configurato è una parte come le altre. Risolto
lì significa: `NULL` diventa il default della rotta prima di entrare nel
digest, così due configurazioni che chiamano il modello nello stesso modo
producono la stessa chiave anche se una lo dice e l'altra lo sottintende.

## Sezione 4 — Il discovery

Tre difetti distinti sotto una segnalazione sola. I primi due riguardano cosa si
vede; il terzo cosa si chiede.

### 4A — Un listato si vede come niente

La scheda Esclusioni mostra `source_text` (`app/main/exclusions/review.ts:37`),
che è il sorgente **mascherato**. Per un `<pre><code>…</code></pre>` il
segnaposto opaco inghiotte tutto e il testo mostrato è letteralmente `<0></0>`.

Su questo libro **tutte e 1147** le unità di codice si presentano così: una pila
di righe vuote identiche, in un gruppo piatto unico, senza documento né
posizione. La scheda Unità ha lo stesso difetto (`app/main/units/list.ts:75`).

Il testo vero c'è già. `unit.raw_text` — colonna aggiunta dalla migrazione 002
esattamente perché il mascherato non è ricostruibile — contiene:

```
<code>interface Album {\r\n  title: string;\r\n  artist: string;\r\n}\r\n</code>
```

**Le due schede leggono `raw_text`**, con i tag rimossi e le entità decodificate,
e mostrano documento e posizione accanto a ogni voce. Il gruppo si spezza per
documento: «quaranta blocchi esclusi dal foglio di stile» è una domanda sola,
ma milleduecento in fila non sono più una domanda, sono un muro.

Una voce lunga si mostra troncata a poche righe, espandibile. Il testo grezzo
non è HTML da interpretare: va reso come testo, in carattere a spaziatura fissa.

### 4B — E le 101 volte in cui si vedono due righe

Questo è il «diviso in più blocchi» osservato. Il libro mette i segnalibri di
pagina **dentro** il listato:

```html
<pre><code><span aria-label="199" epub:type="pagebreak" id="pg_199"
  role="doc-pagebreak"/>interface Album {
```

`aria-label` è un attributo traducibile (`TRANSLATABLE_ATTRIBUTES` in
`core/epub/blocks.ts:198`), quindi nasce un'unità attributo, che eredita lo
stato del blocco che la contiene:

```ts
// core/epub/blocks.ts:401
state: state === "translate" ? "translate" : state,
```

Risultato: il listato compare come **due voci** — una vuota e una che dice
`199`. Succede 101 volte su 1147, ed è la sorgente esatta dei 101 «run di
lunghezza 2» misurati sopra.

**Un marcatore di pagina non è contenuto.** La regola si legge dall'elemento,
non dal valore: un elemento con `epub:type` che contiene `pagebreak` o con
`role="doc-pagebreak"` non produce unità attributo, in nessuno stato. Leggerla
dall'elemento e non dal valore è ciò che evita di indovinare: un `aria-label`
che è solo un numero potrebbe essere qualsiasi cosa, un `doc-pagebreak` no.
`content.pending` si costruisce a `blocks.ts:301` dove l'`ElementNode` — e
quindi i suoi attributi — è in mano.

**Onestà su Translator:** su questo punto non era migliore. Produceva le stesse
282 unità attributo numeriche, e le mandava a tradurre. Semplicemente non aveva
una schermata dove guardarle. Questo non è un ritorno, è una correzione.

### 4C — La domanda sbagliata

Qui la regressione è reale e documentata dal prototipo stesso.
`core/analyze/code.ts` di babelBook è la **versione 1** del classificatore.
Translator è alla 3, e il commento in testa a `src/analyze/code.ts` dice cosa
costò la 1:

> *troncati e chiesto «is this code?», il modello chiamò codice 432 blocchi su
> un libro vero, almeno 86 dei quali prosa semplice.*

E cosa costò la 2:

> *i falsi positivi residui erano quasi tutti una riga sola: «The code files for
> the chapter can be found at https://…».*

Le differenze, misurate riga contro riga:

| | Translator v3 | babelBook oggi |
|---|---|---|
| domanda | «un traduttore lo tradurrebbe o lo ricopierebbe?» | «is this code or prose?» |
| giudizio | esplicitamente sull'**intera** riga | non detto |
| etichetta | `elemento.classe` per ogni blocco | assente |
| forma | sorgente appiattito su **una** riga | sorgente grezzo, multilinea |
| identificatori | ordinali compatti `[1]` | id completi `[v:doc.xhtml#12]` |
| batch | 60 | 20 |
| tentativi | 3, col motivo del rifiuto rimesso nel prompt | 2, muti |
| esecuzione | in parallelo | sequenziale |

Due di queste non sono preferenze ma difetti di trasporto:

- **il sorgente multilinea in un formato «una riga per blocco»** è un modo
  concreto perché una risposta torni malformata; un blocco che contiene una
  riga `END` termina il parsing in anticipo (`code.ts:53`);
- **l'etichetta assente** toglie al modello il segnale che il commento di
  Translator chiama *«esattamente il segnale che questo passaggio chiede di
  pesare»*: la classe del blocco.

**Il passaggio adotta le tre lezioni.** Non è una riscrittura: è il prompt, il
formato di trasporto e la forma del ciclo.

Una cosa di babelBook resta e non si tocca: un sospetto diventa `maybe-code`,
uno stato di lavoro, e va comunque al traduttore. Translator bloccava. Il
commento in `code.ts:93` spiega perché la scelta di babelBook è migliore — «*The
src/ directory* è prosa con dentro un percorso» — e regge anche con la domanda
giusta.

### La versione del passaggio

`store.codeIndex(sourceHash)` è indicizzato su `cache_key`
(`app/main/db/store.ts:209`), e quella chiave porta `PROMPT_VERSION` e
`CONTEXT_VERSION` ma **non** una versione del code-index. Cambiare il prompt
senza aggiungerla farebbe riusare un indice prodotto dalla domanda sbagliata:
il difetto sopravviverebbe alla propria correzione.

**Ma non entra nella chiave condivisa.** Metterla in `CacheKeyInput` accanto a
`PROMPT_VERSION` butterebbe via anche le traduzioni ogni volta che si corregge
una domanda sul codice, e le traduzioni non sono state prodotte da quella
domanda. Sarebbe la stessa mescolanza al contrario: pagare due volte per una
cosa che non è cambiata.

`project_phase_result` ha già una `cache_key` **per fase**
(`app/main/db/store.ts:209`), quindi la fase può conservarsi sotto una chiave
derivata: `codeIndexKey = digest(cacheKey, CODE_INDEX_VERSION)`, calcolata dove
oggi si passa `config.cacheKey` a `indexCodeBlocks`. Alzare la versione butta
via l'indice e nient'altro.

`CODE_INDEX_VERSION = 2` vive accanto alle altre in `core/translate/versions.ts`,
con la stessa regola: chi modifica il prompt di `code.ts` la alza nello stesso
commit.

## Sezione 5 — Il nome del provider

Il campo esiste in tabella dalla migrazione 001 (`provider.name`). È il modulo
che lo nasconde:

```html
<!-- app/renderer/src/app/settings/providers.html:158 -->
@if (form.id !== null || (form.catalogId === null && form.needsUrl)) {
```

Il nome si chiede solo quando stai modificando, o quando stai creando un
endpoint compatibile. Aggiungendo dal catalogo, il nome è quello del catalogo e
non si tocca: due chiavi OpenAI diverse — di lavoro e personale, o due account —
diventano due voci indistinguibili in un elenco che le mette entrambe in cima
fra i connessi.

**Il campo si mostra sempre**, precompilato col nome del catalogo e
modificabile. Nessun vincolo di unicità: due provider possono legittimamente
chiamarsi uguale, ed è chi li ha creati a saperlo.

Il titolo del modulo, che oggi mostra `form.name` come intestazione fissa per le
voci di catalogo (`providers.html:154`), diventa il nome del **catalogo** —
l'identità di ciò che stai collegando — mentre il campo porta il nome che gli
dai tu.

## Cosa questo documento non affronta

- **L'ordine dei gruppi nelle Esclusioni** oltre la spezzatura per documento.
  Ordinare per gravità o per lunghezza è un'altra decisione, e va presa
  guardando la schermata corretta, non questa.
- **La concorrenza della fase di traduzione.** `config.concurrency` esiste ed è
  rispettata; il code-index è l'unico passaggio sequenziale, e viene messo in
  pari con gli altri. Nient'altro cambia.
- **Il costo per fase nel report.** I token diventano attribuibili a una fase
  una volta che il decoratore esiste, ma il report continua a dichiarare un
  totale. Separarli è un'aggiunta, non una correzione.
- **L'attributo traducibile su un elemento di blocco** (`<p title="…">`), che
  `STATO.md` elenca fra i limiti noti del piano 1. Resta aperto: 4B toglie
  unità attributo che non dovevano nascere, non ne aggiunge di mancanti.

## Le migrazioni

Una sola, la **009**:

```sql
ALTER TABLE run ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provider_model ADD COLUMN reasoning_enabled INTEGER;
```

## Come si prova

Le tre cose che nessuna suite dimostra oggi e che questo lavoro rende
dimostrabili:

- **La barra e i token** si provano con il backend finto: una fase lenta e
  contabile emette progresso e uso, e la prova end-to-end guarda i numeri
  cambiare senza un provider vero.
- **4A e 4B** si provano sull'estrattore, senza rete: le stesse misure di
  questo documento diventano asserzioni — 1147 unità di codice, nessuna col
  testo vuoto, nessun run di lunghezza 2.
- **4C** non si prova sulla qualità dei verdetti, che richiede un modello. Si
  prova sul trasporto: un blocco multilinea che contiene la parola `END` non
  rompe più il parsing, e l'esempio nel prompt viene riletto dal parser del
  passaggio stesso — la stessa tecnica già usata per il prompt di traduzione nel
  lavoro in corso su `instructions.ts`.
- **Il ragionamento** si prova sulla risoluzione: l'interruttore acceso su una
  rotta produce le opzioni di quella rotta, spento produce il default, e la
  chiave di cache cambia fra i due.
