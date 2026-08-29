# Stato del lavoro

Aggiornato al 2026-08-29. Serve a riprendere da zero contesto: dove siamo, cosa
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

Suite: **818 test verdi** (297 core, 394 app, 127 componenti) piu' **13 prove
end-to-end**, fra cui un libro intero dal file all'EPUB tradotto, una pausa con
ripresa che non ritraduce nulla, una persona che attraversa a mano i due gate, e
la modifica di un termine che dichiara cosa disferebbe prima di disfarlo.
Typecheck e build di produzione sono puliti.

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

**E resta la prova che nessuna suite può dare**: un libro vero con un provider
vero. È il rischio numero uno da sempre. Ora si fa tutto dall'interfaccia:
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
