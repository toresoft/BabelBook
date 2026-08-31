# Stato del lavoro

Aggiornato al 2026-08-31. Serve a riprendere da zero contesto: dove siamo, cosa
viene dopo, e cosa si è già scoperto che i piani non sapevano.

## Come si lavora qui

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
npm install
npm test            # core e app
npm run typecheck
npm run build -w app
npm start -w app    # apre la finestra
```

Node 24.18.x. Il core è ESM con import `.ts` e **solo sintassi cancellabile**
(niente `enum`, `namespace`, parameter properties). `app/` viene impacchettato
da esbuild; il renderer dal builder di Angular.

Le caselle `- [ ]` dentro i piani sono rimaste vuote anche dove il task è
finito: l'esecuzione è passata da commit, uno per task, e lo stato vero è
quello in testa a ogni piano e qui sotto. Non fidarti delle caselle.

I piani stanno in `docs/superpowers/plans/`, la spec in
`docs/superpowers/specs/2026-08-24-babelbook-design.md`. **Dove piani e codice
divergono, vince il codice**: i piani sono stati scritti senza eseguire nulla e
diversi loro dettagli si sono rivelati sbagliati. Ogni piano porta in fondo, o
nei messaggi di commit, la traccia di cosa è stato corretto e perché.

## Dove siamo

| Piano | Stato | File |
|---|---|---|
| 1. Layer EPUB del core | **completo**, 17/17 | `core/epub/` |
| 2. Layer traduzione del core | **completo**, 14/14 | `core/translate/`, `core/analyze/`, `core/glossary/`, `core/ports.ts` |
| 3. Shell Electron e database | **completo**, 11/11 | `app/main/`, `app/shared/`, `app/renderer/` |
| 4. Esecuzione, provider, composizione | **completo**, 9/9 | `app/main/providers/`, `app/engine/`, `app/main/run/`, `app/main/compose.ts`, `core/workflow/` |
| 5. Gate, glossari, report | **completo**, 8/8 | `app/main/terms/`, `app/main/exclusions/`, `app/main/glossaries/`, `app/main/report/`, `app/renderer/src/app/project/` |
| 6. CI e pacchetti | task 1-3 e 6-8 fatti, 4 a metà, 5 non verificabile qui | `.github/`, `app/electron-builder.yml` |
| 7. Catalogo provider e modelli locali | **completo, 9/9** — tranne la prova dal vivo del Task 3 | `app/main/catalog/` |
| 8. Interfaccia | **completo** | `app/renderer/src/app/` |
| B1. Fondazione daisyUI | **completo**, 7/7 + ondata finale | `app/renderer/` |
| B2. Il guscio e le azioni | **completo**, 7/7 + ondata finale | `app/renderer/` |
| C. La schermata dei provider | **completo**, 7/7 + ondata finale | `app/renderer/src/app/settings/` |
| Provider inclusi | scritto, non iniziato | `app/main/providers/` |
| 9. La corsa osservabile e il discovery | **completo**, 11/11 + revisione finale dell'intero ramo | `core/analyze/`, `core/translate/usage.ts`, `app/main/run/`, `app/main/providers/` |
| Difetti trovati sul primo libro vero | **quattro, corretti** | `app/renderer/src/app/project/`, `app/main/providers/`, `app/main/run/`, `core/workflow/` |
| Provider obbligatorio e auto-accettazione per progetto | **completo**, 10/10 | `app/main/db/migrations/015-*`, `app/main/projects/`, `app/renderer/src/app/project/side/`, `app/renderer/src/app/library/` |

Suite: **975 test verdi** (336 core, 463 app, 176 componenti) piu' **14 prove
end-to-end verdi** e una saltata — `packaged`, che gira solo contro un pacchetto
gia' costruito. Fra le altre: un libro intero dal file all'EPUB tradotto, una
pausa con ripresa che non ritraduce nulla, una persona che attraversa a mano i
due gate, e la modifica di un termine che dichiara cosa disferebbe prima di
disfarlo. Typecheck e build di produzione sono puliti.

**Le cinque prove e2e che erano rosse da giorni sono state corrette**, e nessuna
delle cinque era un difetto del prodotto: erano tre doppi e asserzioni rimasti
indietro rispetto al codice che imitano.

- **Quattro** (`gates` ×2, `translate` ×2) morivano su «the project never
  reached done; it is incomplete». Il backend deterministico di
  `app/engine/fake.ts` rispondeva ancora al formato `VERDICTS` che `5c0ac87`
  aveva sostituito con `#CODEINDEX`/`#CODEVERDICT`: la domanda non matchava
  nessun ramo, cadeva sulla frase di campionamento, ogni batch si asteneva, e
  un'astensione e' una degradazione che manda il libro in `incomplete`. Il
  fake non aveva **un solo test**: e' il buco da cui e' passato, e ora c'e'
  `app/test/fake.test.ts`, che gli fa le tre domande vere attraverso le
  funzioni vere. Il prossimo formato che cambia si rompe li' in due secondi,
  non nella suite in tre minuti.
- **Una** (`gates` ×1, la seconda meta') cercava `li.term` e
  `strong.term__source`: markup che `63b86aa` ha riscritto in `.table__row`,
  spostando il selettore della regola dentro il dialogo del termine.
- **Una** (`providers`) pretendeva un solo campo nel form di connessione.
  `55e760e` — «un nome che lo distingue» — ne ha aggiunto uno apposta, con il
  suo unit test, e l'e2e non l'ha seguito.

La lezione generale: **un doppio senza test deriva in silenzio**, e la deriva
si presenta come un difetto del prodotto in una prova lunga.

**Il default dei due gate e' ribaltato, ed e' per progetto.** Un libro nasce
accettando termini ed esclusioni senza chiedere; chi vuole fermarsi lo dice
alla creazione o dalla schermata di modifica del progetto. Le due caselle non
esistono piu' in *Impostazioni → Traduzione*, che ora tiene solo la
concorrenza. Un progetto senza provider non si puo' piu' creare: la libreria
spegne il bottone e `app/main/projects/provider.ts` rifiuta al confine.
`project.provider_id` resta pero' nullable — i database gia' in giro possono
avere libri orfani, e nessuna migrazione sceglie un modello al posto di
qualcuno.

I test dei componenti girano col builder `@angular/build:unit-test`
(`npm run test:ui -w app`), agganciato a `npm test`.

## Il prossimo passo

**Il piano «Provider inclusi»** — i pacchetti provider imbarcati, i 199
provider serviti senza installare nulla, i 4 rifiutati prima della scelta.
Scritto in
`docs/superpowers/plans/2026-08-27-babelbook-provider-inclusi.md`, sette task,
non iniziato.

La CI e' verde su GitHub (entrambi i job, prove end-to-end comprese) ma **non
l'ho mai vista fallire**: finche' non si rompe un test di proposito e non la si
guarda cadere, e' un badge.

Poi restano due cose, entrambe fuori dalla portata di questa macchina:
`libxcrypt-compat` per costruire `.deb` e `.rpm` su Fedora, e un runner Windows
per l'`.exe`.

**La prova che nessuna suite poteva dare è stata fatta**: un libro vero (3347
unità, DeepSeek) tradotto dall'interfaccia. Ha trovato quattro difetti che
818 test non avevano visto, e nessuno dei quattro era nel core:

- **le due barre** mostravano gli stessi due numeri: una domanda sola, fatta
  due volte, e durante code-index la barra del libro contava batch;
- **il ragionamento non si spegneva**: l'89% dei token in uscita era pensiero,
  perché la grafia di «non pensarci» era indicizzata per route dell'SDK e
  quel provider viaggia su `openai-compatible`, che è un protocollo e non un
  editore. La route generica per giunta non riceveva un `name`, quindi l'SDK
  leggeva le opzioni sotto la chiave `undefined`: nessuna opzione, di nessun
  tipo, poteva raggiungerla;
- **la composizione chiedeva l'impronta invece della chiave di cache**: zero
  traduzioni trovate, ogni unità riemessa dal sorgente, e un EPUB inglese con
  i metadati italiani — senza che una sola invariante si rompesse;
- **`done` non accettava nulla**: un libro composto male non si poteva
  ricomporre se non ritraducendolo da capo.

Il primo era visibile a occhio, gli altri tre solo leggendo il database della
corsa. `makeRunRuntime` non era importato da nessun test: è il buco da cui è
passato il terzo.

Il secondo libro, tradotto con la correzione del ragionamento, ne ha trovato
un quinto: **il modello ha risposto in cinese a 645 unita' su 1686**,
rispettando ogni regola del protocollo. Da li' sono venute quattro cose:

- **il sesto livello di validazione**, che guarda la scrittura in cui la
  risposta arriva. I cinque livelli chiedono tutti se la forma e' giusta, e
  una traduzione nella lingua sbagliata ha la forma giusta;
- **le istruzioni riequilibrate**: erano 1631 caratteri, il 78% sul formato e
  47 sul lavoro. Ora 937, il 39%, e la lingua e' nominata anche subito sopra
  le unita';
- **l'output strutturato** dove il provider lo regge: la forma la impone lo
  schema, e le istruzioni tornano a parlare di traduzione. Due contratti, e
  la chiave di cache li distingue;
- **il ragionamento a forza** (`off`, `low`, `high`, `max`) invece che a
  interruttore.

**Ma la causa era un'altra, e l'ha trovata l'utente.** L'estrazione dei termini
nominava le lingue **con i tag**: al modello arrivava «preparing a *en* book
for translation into *it*», e proponeva 21 rese su 51 in cinese, nove come
`must`. L'auto-accettazione le approvava, e da li' ogni chunk che conteneva una
di quelle stringhe partiva con l'istruzione di renderla in cinese. Le unita'
esposte tornavano con ideogrammi venti volte piu' spesso delle altre — 13,9%
contro 0,7%. `languageName()` esisteva da sempre e li' non era usata.

Da quella scoperta due correzioni: le lingue si nominano, e una resa scritta in
una scrittura in cui la lingua di destinazione non si scrive diventa una
**domanda aperta** invece che un candidato — l'auto-accettazione approva solo i
candidati.

E un difetto introdotto riequilibrando le istruzioni, trovato dai dati: senza
la frase che nominava `UNITS <n>` il modello smetteva di scriverla, e il parser
scartava l'intera risposta al livello 1 — 180 unita' a terra su 368, tutte con
la traduzione giusta dentro. Ora il **primo marcatore ancora il blocco**.

## La prova che nessuna suite poteva dare: fatta

Lo stesso libro (1686 unita'), applicazione corretta, ragionamento **spento**:

| | ideogrammi | ricadute | primo tentativo |
|---|---|---|---|
| prompt v2 | 645 (38%) | 0 | — |
| v3 + bug del parser | — | 180/368 (49%) | ~48% |
| **oggi** | **0** | **0** | **99,5%** |

3 minuti e 11 secondi, $0,049, composizione `complete`, zero invarianti rotte,
31 termini applicati e nessuno in cinese.

Accanto, **Translator** sullo stesso libro con lo stesso modello e lo stesso
pensiero spento: 1950 unita' (segmenta piu' fitto), zero ricadute, 99,6% al
primo tentativo, zero ideogrammi, ~4m30s — e **nessuna terminologia**, perche'
il suo `method` era `skipped-no-glossaries`.

Il sesto livello e la guardia sulle rese **non sono mai scattati**: zero
domande aperte, zero rifiuti `wrong-script`. Sono garanzie che non hanno dovuto
agire, e servono perche' la prossima volta che un modello sbaglia lingua non
finisca in un libro composto e dichiarato `complete`.

## Il prossimo passo, e una decisione aperta

**Translator non chiede mai la resa al modello.** Il tipo dei suoi candidati
non ha un campo `target`: propone `source`, `rule`, `note`, e scrive il target
**vuoto** per tutto cio' che non e' `dnt`, cosi' un file approvato con un
`must` senza resa fallisce rumorosamente. Il commento in testa a
`src/analyze/candidates.ts` lo motiva: *«over-generation is the measured
failure mode of automatic term extraction; the approval gate is the
mitigation»*. Adottarlo renderebbe impossibile l'intera classe di errore invece
di intercettarne una parte — al prezzo di cambiare il senso
dell'auto-accettazione, che approverebbe soltanto i `dnt`.

Restano anche i **21 termini cinesi** nel database del progetto vecchio:
l'orchestratore salta la fase dei candidati quando `store.terms()` non e'
vuoto, quindi nemmeno una chiave di cache nuova li rimuove. Vanno rifiutati a
mano.

Il resto della prova dal vivo si fa dall'interfaccia:
Impostazioni → Provider → un preset → la chiave → Verifica; poi un libro corto,
con l'auto-accettazione spenta per vedere i due gate. Con questo piano, la
prova guarda anche **la barra della fase muoversi durante il code-index** e
**il conteggio dei token salire prima del primo chunk tradotto** — le due cose
che prima nessuno poteva vedere.

## Decisioni prese durante l'esecuzione

Non sono nei piani originali. Sono nel codice e nei commit.

- **Tre regole terminologiche**, non due: `dnt`, `prefer`, `must`. Misurato sui
  glossari veri del prototipo: 73 `dnt`, 55 `prefer`, 1 `must`. `prefer` non è
  `must`, e mapparla rafforzerebbe 55 regole che l'autore aveva lasciato
  deboli. I termini portano anche un campo `sense`.
- **`interleaved` nel contesto di un gruppo**: le unità non traducibili in mezzo
  a un gruppo si spediscono come contesto invece di spezzare il gruppo. Sul
  libro TypeScript misurato ci sono 1248 unità di codice, e spezzare a ogni
  interruzione moltiplicherebbe le chiamate.
- **`verifyDeclared`** sulla lingua: lo stato `conflict` della spec era
  irraggiungibile, perché ci si ferma alla dichiarazione plausibile. Ora è
  l'interfaccia a chiedere un secondo parere.
- **`none-applies`** nel voto sul dominio: "nessun glossario si applica" è una
  decisione, non un'astensione.
- **`shared/dto.ts`**: i tipi che attraversano l'IPC non dipendono da niente,
  altrimenti il compilatore Angular tira dentro tutto il processo main.
- **`packFailure`/`unpackFailure`**: Electron serializza una invocazione
  rifiutata al solo messaggio, quindi un codice di errore non sopravvive al
  confine. Ogni fallimento viene impacchettato nel messaggio e spacchettato
  dall'altra parte; `IpcService` rifiuta con un `IpcFailure`.
- **`project.update`**: l'analisi scrive prima che l'utente confermi, quindi
  lingua e descrizione si confermano dopo, e annullare cancella il progetto.
- **Colonne aggiunte allo schema**: `unit.raw_text` (migrazione 002),
  `term.rule` con `prefer` e `term.sense` (003), `project.cover_file` e
  `project.cache_key` (004), `project_phase_result` (005).
- **Protocollo dell'engine in `shared/run.ts`**: il processo engine non apre
  SQLite; usa un `MessagePort` dedicato e un proxy con allowlist esplicita dei
  metodi di `ProjectStore`. I payload malformati vengono ignorati o rifiutati,
  non possono abbattere il main.
- **Lo snapshot della macchina è la verita'**: la colonna `project.state` è
  denormalizzata. Al riavvio si reidrata lo snapshot e ogni progetto davvero
  `running` passa a `paused`, anche se la colonna era rimasta indietro.
- **Risultati di fase persistenti**: candidati termini e code-index vengono
  salvati prima della transizione. Il checkpoint del code-index copre anche il
  risultato vuoto, è legato alla chiave della configurazione e rende la ripresa
  idempotente; le astensioni diventano eventi di degradazione.
- **Ganci per le prove end-to-end**, letti in un punto solo di `main.ts`:
  `BABELBOOK_USER_DATA` sposta database e workspace, `BABELBOOK_EPUB_FOR_TEST`
  fa restituire un percorso al posto del dialogo nativo.
- **Il progresso è una coppia, non un numero** (piano 9): quanto del libro è
  tradotto è un fatto del database, monotono, vero anche a corsa ferma; cosa
  sta facendo la fase adesso è un fatto della fase, che riparte a ogni fase.
  Confondere le due faceva una barra corretta e illeggibile.
- **Il conto è un decoratore attorno al backend** (`countingBackend`), montato
  una volta: nessuna fase futura può dimenticare di contare. I token si
  scrivono nella riga `run` mentre **arrivano**, non alla fine — una corsa
  fermata a un gate ha comunque speso ciò che ha speso (migrazione 009).
- **Il code-index chiede la domanda del traduttore** — «la tradurresti o la
  riscriveresti?», con elemento e classe accanto al testo, batch da 60 in
  parallelo — invece di «è codice?». La sua versione (2) sta in una chiave
  propria derivata (`codeIndexKey`), non nella chiave condivisa: correggere la
  domanda non butta via le traduzioni. Con esso: un marcatore di pagina non è
  una voce, e le schede mostrano i byte veri spogliati del markup.
- **Il ragionamento è una scelta del modello**: `ProviderModel.reasoningEnabled`
  (null = non scelto, si legge come spento), composto in `resolveRouteOptions`
  che normalizza le opzioni di ogni rotta, e il booleano risolto entra nella
  chiave di cache (migrazione 011, che ripulisce il vecchio default DeepSeek).
  L'interruttore in UI chiede conferma, perché cambiare la chiave getta via le
  traduzioni fatte con quel modello.
- **L'aggiornamento stesso ricalcola ogni chiave e ripaga una volta**: col
  booleano risolto del ragionamento entrato nella chiave di cache, alla prima
  corsa dopo questo ramo la `project.cache_key` ricalcolata è diversa da
  quella salvata per ogni progetto creato prima, e le sue traduzioni vengono
  rispese una volta. Per le quattro rotte note è forzato: le loro richieste
  cambiano davvero, ora che lo spento viaggia come direttiva esplicita. Per
  le rotte non mappate è uniforme ma gratuito — e resta uniforme di proposito,
  perché una chiave condizionale alla rotta avrebbe reintrodotto la divergenza
  silenziosa tra richiesta e cache. Accettato deliberatamente, essendo il ramo
  pre-rilascio.

## Cosa nessuna suite dimostra

- **Nessun test costruisce un backend funzionante**: servirebbe la rete. Un
  errore di cablaggio in `resolve.ts` o `sdk.ts` passerebbe tutti gli 818 test.
  Va provato a mano con un provider vero, ed è il rischio numero uno.
- **Font offuscati**: mai passati dalla pipeline. `RSC-004` fa saltare a
  EPUBCheck il contenuto delle risorse cifrate, quindi il fallimento è
  invisibile.
- **Impaginazione fissa**: rilevata e dichiarata, mai risolta.
- **Rimozione degli overlay**: specificata e coperta da un'invariante, mai
  eseguita su un audiolibro vero.
- **L'icona nel tray non compare su KDE/Wayland.** Misurato: `new Tray()` non
  solleva eccezioni e l'oggetto resta vivo, ma nessun `StatusNotifierItem` si
  registra su DBus, mentre altri programmi nella stessa sessione si registrano.
  Un Electron di dieci righe si comporta identicamente, quindi la causa non e'
  in babelBook. Resta aperto. Nel frattempo, senza tray la finestra non si
  nasconde piu' alla chiusura, cosi' non diventa irraggiungibile.
- **Un attributo traducibile sull'elemento di blocco** (`<p title="…">`) non
  viene tradotto: le unità attributo nascono solo dai segnaposto inline. Limite
  noto del piano 1, da chiudere prima di tradurre libri veri.

## Verifiche su libri reali già fatte

Su quattro EPUB in `~/Development/OWN/Translator/`:

- estrazione più riempimento nullo restituisce **ogni documento byte per byte**
  (137 documenti, 20.778 unità);
- l'ingestione completa funziona su tutti e quattro, con conteggi identici;
- *The Dig* in originale dichiara `UND` e finisce in `needs-language`, che è il
  comportamento voluto.

## Rami

Il lavoro è lineare su `master`. I rami `worktree-agent-*` sono già confluiti e
si possono cancellare (`git branch -D`), oppure tenere come traccia di chi ha
scritto cosa.

Il ramo `corsa-osservabile` ha portato il piano 9 e confluito su `master`; il
ramo è stato cancellato dopo la verifica della suite sul risultato del merge.
