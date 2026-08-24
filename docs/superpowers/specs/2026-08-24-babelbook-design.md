# babelBook — design

**Data:** 2026-08-24
**Stato:** approvato in brainstorming, da tradurre in piano di implementazione

## Contesto

babelBook è un'applicazione Electron per tradurre libri EPUB con un LLM,
organizzata per progetti. Nasce da `~/Development/OWN/Translator`, un CLI che ha
portato la pipeline di traduzione fino a funzionare su libri reali. Quel
prototipo non viene incluso né importato: **si riscrive**, riusando le soluzioni
che hanno retto sul campo e correggendo quelle che non hanno retto.

Il documento è scritto in italiano perché in italiano è avvenuta la
progettazione. Codice e commenti sono in inglese.

## Obiettivi

- Un'interfaccia grafica per tradurre EPUB, senza toccare riga di comando.
- Un progetto per libro, con workspace, stato persistente, pausa e ripresa.
- Configurazione dell'applicazione: provider LLM (solo API) e glossari.
- Controllo umano dove serve: approvazione dei termini e revisione di ciò che
  non verrà tradotto, entrambi saltabili.
- Interfaccia localizzabile.

## Non obiettivi

- Formati diversi da EPUB. MOBI, AZW, AZW3, KFX, KPF restano fuori, anche in
  lettura: tenerli fuori evita una dipendenza GPL-3.0 da Calibre, un parser
  binario e la gestione del DRM. Un file non-EPUB viene rifiutato all'ingresso
  con un messaggio che nomina il formato.
- Backend che pilotano una CLI o un agente. Solo API.
- Traduzione di più libri in parallelo. Uno alla volta.
- Editing dell'EPUB oltre alla traduzione.
- Sincronizzazione, account, cloud.

## Decisioni

| Questione | Decisione |
|---|---|
| Rapporto col prototipo | Riscrittura; il codice del prototipo è materiale di riuso, non dipendenza |
| Stato del lavoro | SQLite per tutto lo stato strutturato, disco solo per gli artefatti |
| Concorrenza | Un progetto per volta; la traduzione continua in background a finestra chiusa |
| Chiavi API | `safeStorage` di Electron, blob cifrato nel database |
| Glossari | Glossari globali dell'applicazione + termini di progetto, associazione sempre correggibile |
| Gate manuali | Due: approvazione termini e revisione delle esclusioni, indipendentemente saltabili |
| Stack UI | Angular 22 |
| Localizzazione | Transloco, cataloghi JSON a runtime |
| Confine | Monorepo npm workspaces: `core/` puro, `app/` Electron |
| Macchina a stati | XState 5, come autorità sugli stati e non come esecutore |
| Impaginazione fissa | Rilevata all'ingestione e dichiarata all'utente; il libro si traduce comunque |
| Lettura sincronizzata | Gli overlay SMIL vengono rimossi dall'EPUB tradotto, con i loro metadati e l'audio rimasto orfano |

## Runtime

- Electron 43 (Node 24.18.1 incorporato), ESM ovunque.
- `node:sqlite` (`DatabaseSync`) per il database: nessun binario nativo, nessun
  `electron-rebuild` a ogni aggiornamento di Electron.
- Angular 22 per il renderer, costruito da Angular CLI.
- `esbuild` per i tre bundle di `app/`: main, preload, engine.
- `core/` scritto in modo da poter girare anche con `node core/...` senza
  build, per prove manuali: import con estensione `.ts` esplicita e sintassi
  cancellabile (niente `enum`, niente `namespace`, niente parameter properties).

## Architettura

### Struttura

```
core/            motore; non conosce Electron né SQLite
  epub/          zip, scan, blocks, skeleton, package, inspect, invariants, epubcheck
  translate/     wire, validate, plan, engine, instructions, versions
  analyze/       lingua, dominio, candidati termini, indice del codice
  glossary/      parsing, merge e identità dei glossari
  workflow/      project.machine.ts — la macchina a stati XState
  ports.ts       le interfacce che il core richiede a chi lo ospita
app/
  main/          finestra, database, safeStorage, orchestrazione, tray, IPC
  preload/       contextBridge tipizzato
  engine/        entry point dell'utilityProcess: core + adattatori
  renderer/      Angular 22
  locales/       cataloghi JSON condivisi da main e renderer
```

### Porte (`core/ports.ts`)

Il core non apre file di stato e non sa cosa sia una finestra. Dichiara di cosa
ha bisogno:

- **`ProjectStore`** — lettura e scrittura di documenti, unità, traduzioni,
  termini ed eventi. Implementato in `app/` su SQLite; nei test da una
  implementazione in memoria.
- **`LlmBackend`** — una chiamata: prompt dentro, testo e conteggio token
  fuori. Nessun nome di provider e nessun id di modello compare in `core/`; un
  test che scandisce i sorgenti fa rispettare il confine.
- **`ProgressSink`** — eventi di fase e di avanzamento, strutturati.

### Processi

- **main** — possiede il database e le chiavi. Nessun lavoro pesante: finestra,
  coda, avvio e arresto dell'engine, inoltro degli eventi al renderer.
- **engine** (`utilityProcess`) — uno solo, vivo finché un progetto lavora.
  Riceve `start(projectId)`, `pause`, `cancel`; emette eventi su `MessagePort`.
  Non tocca il database: passa da `ProjectStore`, che qui è un proxy IPC verso
  il main. Un crash lascia intatti finestra e database, e il progetto riparte
  dall'ultima unità confermata.
- **renderer** — Angular, `contextIsolation` attivo, nessun accesso a Node,
  nessun percorso di file costruito nella finestra.

### Ciclo di vita

Se un progetto è in traduzione, chiudere la finestra la nasconde e lascia
l'applicazione viva con un'icona in tray; a fine libro arriva una notifica di
sistema. L'uscita è un comando esplicito: con lavoro in corso chiede conferma e
mette in pausa pulita prima di terminare.

Alla riapertura, un progetto trovato in `running` viene riportato a `paused` e
mai ripreso da solo: nessuno spende denaro senza che l'utente l'abbia chiesto.

## Dati

### Database

Uno solo, in `app.getPath("userData")/babelbook.db`, WAL attivo, migrazioni
versionate a mano in `app/main/db/migrations/`.

```sql
project(id, filename, title, author, workspace_path, source_sha256,
        created_at, description, source_language, target_language,
        provider_id, model_id, state, machine_snapshot, layout)
-- state è denormalizzato per i filtri della libreria: la verità è
-- machine_snapshot, e state si riscrive a ogni transizione accettata
project_document(id, project_id, zip_path, spine_order, encoding, read_outcome,
                 layout)
unit(id, project_id, document_id, ordinal, unit_id, range_start, range_end,
     state, source_text, placeholders, forced_state, forced_by)
translation(id, unit_id, text, cache_key, attempts, outcome, created_at)
term(id, project_id, source, target, rule, origin, approval_state, note)
glossary(id, name, description, source_language, target_language, version)
glossary_term(id, glossary_id, source, target, rule, note)
project_glossary(project_id, glossary_id, chosen_by)
provider(id, name, route, base_url, api_key_encrypted, headers, options)
provider_model(id, provider_id, model_id, display_name, context_window,
               price_in, price_out)
run(id, project_id, phase, started_at, ended_at, tokens_in, tokens_out, cost)
run_event(id, run_id, at, code, severity, payload_json)
setting(key, value)
```

Tre proprietà dello schema portano peso:

**Le unità stanno in tabella, non in un file.** È ciò che rende possibile la
scheda delle unità e il gate delle esclusioni: si filtra `unit` per stato e si
mostra il testo, senza rileggere e riparsare l'EPUB.

**La cache è per unità, con chiave.** `cache_key` è composta da versione del
prompt, identità del modello e identità ordinata dei glossari attivi
(`nome@versione`). Cambiare un termine invalida solo le traduzioni delle unità
che lo contengono; cambiare modello o versione del prompt invalida tutto, ma lo
dichiara prima di spendere.

**L'hash del sorgente sta sul progetto.** Se l'EPUB copiato viene modificato,
gli id delle unità non corrispondono più: il progetto lo rileva all'apertura e
chiede di rianalizzare, invece di ricomporre un libro sbagliato in silenzio.

### Workspace

`userData/projects/<projectId>/` contiene solo artefatti veri:

```
source.epub          la copia dell'EPUB scelto
cover.<ext>          la copertina estratta
output/<titolo>.<lang>.epub
export/              esportazioni di termini, su richiesta
```

Nessuno stato: se il workspace sparisce e il database resta, il progetto si vede
ancora e dichiara che il sorgente manca; se sparisce il database, i file
restano leggibili.

L'output va **sempre su un percorso nuovo**, mai sopra l'originale: se il gate
rifiuta il libro, il sorgente è intatto e il file rifiutato resta ispezionabile.

## Impaginazione fissa

L'EPUB 3 non è solo riflowable: `rendition:layout: pre-paginated` posiziona il
contenuto in modo assoluto dentro un viewport a pixel fissi, dichiarato nel
documento XHTML da un meta `viewport` con `width` e `height`. La proprietà sta
nel package e si sovrascrive per singolo `itemref`, quindi un libro può
mescolare capitoli riflowable e tavole pre-paginate. È così che sono distribuiti
fumetti, manga, libri illustrati e per bambini, e molti ricettari.

Tradurre allunga il testo — tra il 15% e il 35% verso le lingue romanze e
germaniche. Dove il testo scorre non succede niente; dove è posizionato in modo
assoluto, la frase più lunga esce dalla sua scatola e viene tagliata o si
sovrappone.

**Nessun controllo automatico lo vede.** EPUBCheck non renderizza: per lui la
struttura è valida, e l'overflow è un esito di rendering, non una violazione
della specifica. Le invarianti strutturali passano per lo stesso motivo.

**Decisione: rilevare e avvisare, non rifiutare.** Il libro si traduce comunque —
è pur sempre l'unico modo di averlo tradotto — ma l'utente deve saperlo prima di
spendere:

- nell'anteprima di **Nuovo progetto**, un avviso che nomina il numero di
  documenti pre-paginati e dice che il testo tradotto non si riadatta;
- un indicatore sullo stesso progetto, nella libreria e nell'intestazione, così
  l'avvertenza non vale solo per il giorno della creazione;
- una riga nel **Report**, perché resti scritto accanto all'esito dei gate.

Il rilevamento costa niente: `rendition:layout` è nell'OPF, che apriamo comunque.
L'avviso non elimina il rischio, lo sposta dove qualcuno può decidere: chi
traduce un fumetto sa che dovrà guardare le tavole.

## Lettura sincronizzata (media overlay)

Un EPUB con media overlay porta file SMIL che accoppiano l'id di un elemento del
testo a un intervallo di un file audio, così il lettore illumina la frase mentre
la voce la legge. Tradurre il testo non rompe il legame — punta agli id, non alle
parole — ma lo svuota di senso: la voce continua a leggere la lingua di partenza
sotto un testo che ora è un'altra.

**Decisione: l'EPUB tradotto non ha overlay.** Un audio nella lingua sbagliata
non serve a nessuno, e trascinarlo significa portarsi dietro decine o centinaia
di megabyte di narrazione inutilizzabile.

Rimuovere vuol dire cinque cose, tutte insieme o nessuna:

1. gli `<item>` dei file SMIL escono dal manifest, e i file escono dall'archivio;
2. l'attributo `media-overlay` sparisce dagli `<item>` dei documenti di
   contenuto che lo portavano;
3. escono i metadati che esistono solo per gli overlay: i `media:duration` per
   singolo overlay dichiarati con `refines`, il `media:duration` totale della
   pubblicazione, `media:narrator`, `media:active-class` e
   `media:playback-active-class`;
4. escono le risorse audio che, tolti gli SMIL, non sono più referenziate da
   nessun documento di contenuto — solo quelle: un `<audio>` scritto nel testo
   è contenuto del libro e resta;
5. gli id degli elementi nei documenti di contenuto **restano dove sono**.
   Erano il bersaglio degli overlay, ma possono essere anche il bersaglio di
   link interni, e toglierli romperebbe la navigazione.

**È l'unica eccezione alla regola dei metadati in sola lettura**, insieme a
`dc:language` e `dcterms:modified`, e va trattata come tale: dichiarata nella
spec, coperta da un'invariante, non lasciata alla buona volontà del codice che
scrive lo zip.

L'invariante verifica che la rimozione sia completa e non parziale: nell'output
non resta nessun file SMIL, nessun `media-overlay`, nessuno dei metadati
dell'elenco, e nessun riferimento pendente. Una rimozione a metà è peggio che
non rimuovere: EPUBCheck rifiuta un `media-overlay` che punta a un item
inesistente, e un `media:duration` orfano fa scattare `MED-016`.

Va dichiarato in due punti: un avviso alla creazione del progetto, perché
l'utente sappia prima di spendere che il libro tradotto perderà la lettura ad
alta voce, e una riga nel Report con quanti overlay e quanti file audio sono
usciti. Il sorgente nel workspace resta intatto: niente è perduto, l'edizione
originale è ancora lì.

## Fasi

### Alla creazione del progetto — locale, salvo un caso

1. **Ingestione** — copia nel workspace, sha256, apertura dello zip, lettura
   dell'OPF, estrazione di copertina, titolo, autore, `dc:language`. Un file
   non-EPUB viene rifiutato qui. Si legge anche `rendition:layout`, ai due
   livelli in cui può comparire: la proprietà del package e la sovrascrittura
   per singolo `itemref` della spine. Ogni documento porta il suo valore in
   `project_document.layout`, e `project.layout` riassume il libro come
   `reflowable`, `pre-paginated` o `mixed`. Si rileva qui anche la presenza di
   overlay SMIL, per poterla dichiarare prima che l'utente spenda.
2. **Separazione in unità** — scansione di ogni documento della spine con
   `saxes`, individuazione dei blocchi foglia, mascheramento del markup inline
   in segnaposto numerati. Ogni unità nasce con uno stato deterministico dedotto
   da markup e CSS: `translate`, `code`, `translate-no`, `never-translated`,
   `uncomposable`. È deterministica e locale: si fa subito, e permette di
   mostrare conteggi e stima di costo prima che l'utente spenda.
3. **Identificazione della lingua** — prima `dc:language` dall'OPF. È l'unico
   punto della creazione che può chiamare il modello, e solo se serve: se l'OPF
   dichiara una lingua plausibile la fase finisce lì, senza costo e senza
   provider. Se manca o è sospetta, un campione va al modello per un voto; se il
   voto si astiene o contraddice l'OPF, la UI chiede conferma. Se il provider non
   è ancora configurato la lingua resta da confermare e la si chiede all'utente:
   la creazione di un progetto non si blocca mai su una chiamata di rete. La
   lingua sorgente è opzionale davvero, non un flag obbligatorio.

Le fasi 1 e 2 sono deterministiche e locali: nessuna rete, nessun costo. Alla
fine il progetto è `ready`.

### Alla partenza della traduzione

4. **Analisi ed estrazione termini** — campionamento di blocchi indipendenti,
   sintesi del libro, voto a maggioranza sul glossario di dominio applicabile
   con astensione facile, estrazione dei candidati con la loro regola: `dnt`
   (non tradurre) o `must` (resa obbligata). La descrizione scritta dall'utente
   entra in questo prompt e in quello di traduzione.
5. **Gate termini** — il run si ferma. La UI mostra i candidati con il contesto,
   il glossario proposto e la possibilità di correggerlo, e permette di
   accettare, rifiutare, modificare la resa o promuovere un termine al glossario
   globale. Con l'auto-accettazione il gate non si ferma.
6. **Identificazione delle parti da non tradurre** — passaggio del modello sui
   blocchi sospetti, che può marcare come codice ciò che le regole hanno
   mancato o liberare prosa che il CSS aveva protetto troppo. Un'astensione non
   cambia mai lo stato deterministico.
7. **Gate esclusioni** — il run si ferma di nuovo. La UI elenca ciò che non
   verrà tradotto raggruppato per motivo, col testo, e l'utente può forzare lo
   stato nei due sensi (`forced_state`, `forced_by`). Saltabile
   indipendentemente dal gate dei termini.
8. **Traduzione unità** — pianificazione in gruppi con finestra di contesto
   (blocchi precedenti e successivi), invio, validazione della risposta su
   cinque livelli — struttura, estrazione, decodifica, insieme esatto degli id,
   segnaposto — e ritentativo mirato che rimanda solo le unità rifiutate con la
   diagnosi. Ogni unità confermata viene scritta subito: è questo che rende la
   pausa gratuita.
9. **Creazione EPUB** — costruzione dello scheletro, riempimento, riscrittura
   del solo `dc:language` e di `dcterms:modified`, rimozione degli overlay se
   il libro ne ha, scrittura dello zip. Poi il
   gate: invarianti strutturali sempre, EPUBCheck se il jar è presente. Se non
   c'è, la UI dice "non eseguito", mai "passato".

## Macchina a stati

`core/workflow/project.machine.ts`, XState 5, dichiarativa:

```
new → ready → running → waiting-terms → running → waiting-code
    → running → composing → done
```

più `paused`, `incomplete` (l'EPUB esiste ma qualche unità è caduta sul
sorgente) e `failed` (il gate ha rifiutato il libro).

Eventi: `START`, `TERMS_APPROVED`, `CODE_REVIEWED`, `PAUSE`, `RESUME`, `FAIL`,
`COMPLETE`. Guard sulle condizioni reali: `hasApprovedTerms`,
`sourceHashMatches`, `hasPendingCandidates`.

**La macchina non esegue.** Come il componente Workflow di Symfony, dice cosa è
lecito; l'orchestratore nel main esegue la fase e poi le manda l'evento. Le fasi
restano funzioni normali in `core/`, testabili senza attori.

Tre cose che se ne guadagnano:

- **Persistenza** — `actor.getPersistedSnapshot()` va in
  `project.machine_snapshot`, `createActor(machine, { snapshot })` lo riprende.
- **Transizioni disponibili per la UI** — `snapshot.can({ type: "RESUME" })`
  decide se il bottone è abilitato: main e renderer leggono la stessa fonte.
- **Transizioni illecite che falliscono** — un `RESUME` su `waiting-terms` non
  fa niente e lo dichiara, invece di far partire una traduzione con termini non
  approvati.

Alternative scartate: **jssm**, filosoficamente più vicino a Symfony ma con
inferenza di tipi debole e comunità piccola; **robot3**, minuscolo ma senza
persistenza dello snapshot, che qui è la funzione che serve di più.

## Ripresa e degradazioni

Ogni fase è idempotente e riprende dal database: la pausa mette un
`AbortSignal`, il gruppo in volo viene abbandonato, le unità già confermate
restano. Riprendere significa ricalcolare cosa manca, non ricordare dove si era.

Ogni degradazione è dichiarata in `run_event` come codice strutturato: unità
caduta sul sorgente, documento illeggibile, gruppo che ha esaurito i tentativi,
astensione della classificazione. Tutte portano il progetto a `incomplete`.

Una superficie che l'autore ha marcato `translate="no"` **non** è una
degradazione: si dichiara e basta.

**Il core non produce testo per l'utente.** Restituisce codici e dati
strutturati (`{ code: "unsupported-encoding", doc, detail }`); la frase la
compone la UI dal catalogo. È l'unico modo perché la localizzazione non diventi
una caccia alle stringhe dentro il motore.

## Configurazione

### Provider

Un provider è: nome visibile, rotta (il pacchetto `@ai-sdk/*` che lo serve),
`baseURL`, chiave, header aggiuntivi, ed elenco di modelli con id, nome, finestra
di contesto e prezzi per milione di token. I prezzi servono alla stima prima di
partire e al costo reale dopo.

Preset per Anthropic, OpenAI, DeepSeek, Mistral e un preset **OpenAI-compatible**
generico che copre OpenRouter, i gateway aziendali e i server locali. I preset
sono valori iniziali, non gabbie.

- **Opzioni per provider come default, non come preferenza.** DeepSeek V4
  ragiona di default e brucia il budget di output in token di ragionamento: il
  gruppo torna vuoto con `finishReason: "length"` e ogni unità cade sul
  sorgente, a prezzo pieno. La correzione è precaricata sul preset e
  sovrascrivibile.
- **La risoluzione del modello avviene prima di aprire l'EPUB.** Chiave assente,
  pacchetto mancante, id malformato si scoprono alla partenza, non al primo
  gruppo, quando l'analisi ha già speso.

La chiave si scrive una volta, la cifra `safeStorage`, il renderer non la rivede
mai: vede "impostata" o "mancante". Un bottone **Verifica** fa una chiamata
minima e riporta l'esito.

### Glossari

Nome, descrizione, coppia di lingue, versione, e termini con sorgente, resa,
regola e nota. La descrizione conta: è ciò che il voto di dominio legge per
decidere se il glossario si applica.

Import ed export in markdown con frontmatter, nello stesso formato del
prototipo, così i glossari già scritti si caricano senza riscriverli.

I glossari proposti dal voto arrivano etichettati (`chosen_by = vote | user`) e
sono sempre correggibili. I termini estratti restano del progetto; ognuno ha un
comando "promuovi al glossario" — è così che i glossari globali crescono.

La versione del glossario entra nella chiave di cache: modificarne uno invalida
le unità che contengono i termini cambiati, non il libro.

## Interfaccia

**Libreria** — griglia di copertine con titolo, lingue, stato e avanzamento.
Filtri per stato, ricerca per titolo.

**Nuovo progetto** — scelta dell'EPUB, copia e analisi con anteprima di quanto
trovato (copertina, titolo, autore, lingua dichiarata, documenti, unità,
parole), poi lingua di destinazione, provider e modello, descrizione del libro,
e la stima di costo calcolata sulle unità reali. Solo allora "Crea".

**Progetto** — intestazione con copertina, stato e le azioni consentite, chieste
alla macchina a stati. Cinque schede:

- *Panoramica* — le fasi col loro esito, avanzamento a unità, token e costo,
  eventi recenti.
- *Termini* — il gate: candidati col contesto, accetta/rifiuta/modifica,
  accettazione in blocco, promozione al glossario.
- *Esclusioni* — il gate delle parti da non tradurre, per motivo, col testo del
  blocco, con forzatura nei due sensi.
- *Unità* — sorgente e traduzione affiancate, filtro per stato, ricerca. È la
  scheda con cui si controlla davvero un libro; nel prototipo mancava.
- *Report* — degradazioni per codice, esito delle invarianti, esito di
  EPUBCheck, apertura dell'EPUB e della cartella.

**Impostazioni** — provider, glossari, lingua dell'interfaccia, auto-accettazione
dei due gate (indipendenti), concorrenza dei gruppi, percorso del jar di
EPUBCheck.

**Tray e notifiche** — icona presente solo mentre un progetto lavora, con stato
e comandi; notifica a fine libro e quando un gate aspetta l'utente.

**Eliminazione** — cancella righe e workspace previa conferma, con l'opzione di
conservare l'EPUB tradotto fuori dal workspace.

### IPC

Il preload espone un oggetto tipizzato con due sole forme: `invoke` per le
richieste (`projects.list`, `project.create`, `run.start`, `terms.approve`…) e
`on` per i flussi di eventi (`run.progress`, `run.phase`, `project.changed`).
La finestra chiede, il main decide.

### Localizzazione

Transloco, cataloghi JSON in `app/locales/<lang>.json` condivisi tra renderer e
main — anche menu di tray, notifiche e dialoghi nativi sono tradotti. Lingua
iniziale da `app.getLocale()`, poi sovrascrivibile e salvata nelle impostazioni.

## Vincoli tecnici ereditati dal prototipo

Sono verità sul dominio, non preferenze; violarle rompe cose che non si vedono.

1. **Il codice che verifica non condivide il parser con quello che trasforma.**
   Se `inspect` e `splice` condividono le assunzioni, un difetto del parser è
   simmetrico e quindi invisibile a un confronto prima/dopo. Il walker XML
   minimale duplicato in `inspect` è deliberato.

2. **Il riempimento salta le unità la cui traduzione è identica al sorgente.**
   Non è un'ottimizzazione: è ciò che rende l'output a traduzione nulla
   identico byte per byte, e quindi il gate un'asserzione vera invece di una
   tautologia. Riscrivendo ogni span, il riescape trasformerebbe `&#38;` in
   `&amp;` e il gate andrebbe indebolito a un confronto semantico.

3. **Ogni invariante ha un controllo negativo.** Una suite che non è mai
   fallita non ha dimostrato di poter fallire. I sabotaggi del prototipo hanno
   già scoperto due invarianti morte.

4. **I confini delle unità seguono il modello di contenuto, non il nome del
   tag.** Nel documento di navigazione `a` e `span` sono blocchi: la foglia è
   l'ancora, non il `<li>`. Un `<li>` di nav non ammette testo nudo, e con il
   `<li>` come foglia una traduzione che mette una parola fuori dal segnaposto
   produce un EPUB che EPUBCheck rifiuta — e i cinque livelli di validazione
   non possono vederlo. Prevenzione, non rilevazione.

5. **I metadati del pacchetto sono in sola lettura tranne `dc:language` e
   `dcterms:modified`.** `dc:identifier` in particolare è immutabile: è la
   chiave di offuscamento dei font, e cambiarlo corrompe i font incorporati in
   silenzio — EPUBCheck non lo prende, `RSC-004` salta le risorse cifrate.
   Titoli, descrizioni e soggetti non si traducono; `alt`, `aria-label`,
   etichette di nav e NCX e testo SVG sì. La linea è metadati contro contenuto.

6. **Solo UTF-8.** Un documento in un'altra codifica viene saltato e contato,
   mai indovinato.

7. **Spostare i confini delle unità cambia gli id** (`{doc}#{ordinale}`), che
   sono le chiavi dello stato. Le voci vecchie non corrispondono a niente e
   vengono ignorate, ma le unità interessate si ritraducono.

8. **`saxes` riporta la posizione dopo aver consumato il `<` che chiude il nodo
   di testo**: `rawEnd = parser.position - 1`, e `rawStart` è la posizione dopo
   l'evento strutturale precedente, non dopo `opentagstart`, che riporta a metà
   tag.

9. **`yauzl-promise` esporta `validateFilename`**, non `validateFileName` come
   dice il suo README. Non ha tipi: serve una dichiarazione a mano sulla
   superficie usata.

10. **`saxes` è archiviato** (repo archiviato a dicembre 2025, ultima release
    novembre 2021). Resta congelato più che abbandonato — circa 87 milioni di
    download a settimana attraverso jsdom — ed è un tokenizer puro senza I/O.
    `sax-wasm` è il bersaglio di migrazione e ha `byteOffsets` nativi:
    l'interfaccia di scansione resta stretta perché lo scambio sia contenuto.

## Cosa cambia rispetto al prototipo

| Prototipo | babelBook |
|---|---|
| Stato in `state/` con jsonl e manifest | SQLite, unico e interrogabile |
| Cambio di configurazione invalida la sessione intera | Invalidazione selettiva per unità |
| Righe di report in inglese generate nel motore | Codici strutturati, frasi nella UI |
| `--from` obbligatorio | Lingua rilevata da OPF più voto, confermabile |
| Unità in `units.jsonl`, non ispezionabili | Unità in tabella, con una scheda dedicata |
| Nessuna revisione delle esclusioni | Gate dedicato, con forzatura nei due sensi |
| Backend agente su CLI più backend SDK | Solo API |
| Stato del run in rami condizionali | Macchina a stati dichiarativa e persistita |

## Verifica

- **Core, vitest.** Ogni fase testata contro un `ProjectStore` in memoria e un
  `LlmBackend` finto. Il corpus generato del prototipo — fixture per modalità di
  traduzione, più i sabotaggi mappati sulle invarianti che devono far scattare —
  viene riportato e ampliato.
- **Confine provider-agnostico.** Un test che scandisce i sorgenti: né
  `core/translate/` né `core/analyze/` possono importare un provider o nominare
  un modello concreto.
- **Identità.** Estrazione più riempimento con traduzione nulla deve restituire
  l'archivio byte per byte, a meno di OPF e `xml:lang` radice, che si
  riscrivono per progetto.
- **Database.** Migrazioni e `ProjectStore` su SQLite testati con
  `node:sqlite` in memoria.
- **Main.** Orchestrazione, gate e ripresa testati con engine finto.
- **Renderer.** Test dei componenti dei due gate e della libreria; il resto è
  presentazione.
- **End-to-end.** Playwright per Electron su un percorso solo: creazione
  progetto, gate saltati, traduzione con backend finto, EPUB prodotto.

## Rischi e punti non verificati

- **Traduzione vera con modello vero.** Il prototipo ha tradotto libri reali,
  ma qui la pipeline è riscritta: finché un EPUB reale non attraversa babelBook
  con un provider reale, nessuna suite lo dimostra.
- **I font offuscati** non sono mai passati dalla pipeline fuori dal corpus
  generato, ed è il caso in cui il fallimento è invisibile: EPUBCheck emette
  `RSC-004` e salta il contenuto delle risorse cifrate, quindi un font reso
  illeggibile da un `dc:identifier` riscritto non viene segnalato da nessuno.
  Serve un libro reale con font offuscati, tradotto e aperto.
- **La rimozione degli overlay** è decisa e coperta da un'invariante, ma non è
  mai stata eseguita su un audiolibro vero: nel corpus generato gli SMIL non
  esistono.
- **L'impaginazione fissa è rilevata ma non risolta.** L'avviso dice all'utente
  che il testo non si riadatta; nessuno verifica che non trabocchi.
- **`node:sqlite` in Electron.** Il modulo esiste in Node 24.18.1 ed Electron 43
  monta quella versione; va confermato nel processo main reale al primo giorno
  di implementazione, con `better-sqlite3` più `electron-rebuild` come ripiego
  dichiarato.
- **Costo dei gate.** Fermare il run due volte è corretto ma allunga il tempo
  fino al primo capitolo tradotto; se l'attesa risulta fastidiosa all'uso, la
  leva è l'auto-accettazione, già prevista, non la rimozione dei gate.
