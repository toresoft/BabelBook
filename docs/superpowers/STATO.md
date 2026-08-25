# Stato del lavoro

Aggiornato al 2026-08-25. Serve a riprendere da zero contesto: dove siamo, cosa
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
| 4. Esecuzione, provider, composizione | **task 1-6 su 9** | `app/main/providers/`, `app/engine/`, `app/main/run/`, `core/workflow/` |
| 5. Gate, glossari, report | non iniziato | — |

Suite: **411 test verdi** (260 core, 151 app) piu' **3 prove end-to-end** del
percorso Electron. Typecheck e build di produzione sono puliti. Il nuovo
end-to-end di traduzione appartiene al Task 9.

## Il prossimo passo

**Piano 4, Task 7** — composizione dell'EPUB e gate del file prodotto. I task
1-6 sono fatti: provider e chiavi cifrate, risoluzione/verifica del modello,
macchina a stati, engine in `utilityProcess` con proxy di `ProjectStore`, e
orchestratore persistente con gate e ripresa idempotente. Dopo il Task 7 restano
tray e ciclo di vita (8), quindi la traduzione end-to-end con backend finto (9).

Quello che l'applicazione fa oggi: si apre, crea un progetto da un EPUB senza
alcun provider configurato, lo mostra in libreria con copertina, lingue,
avanzamento e gli avvisi di impaginazione fissa e overlay. Il motore e
l'orchestratore esistono e sono testati, ma il main non li ha ancora cablati ai
comandi dell'interfaccia: l'applicazione non traduce ancora.

## Da fare appena si riprende il piano 4

- **Il Task 7 deve chiudere l'handoff `compose`.** L'orchestratore emette la
  fase di composizione ma, correttamente, non manda `COMPOSED` o `done` finche'
  non esiste e non passa il gate un EPUB reale.
- **Il Task 8 deve cablare il runtime.** Deve registrare store e crash handler
  con `configureEngineHost`, applicare nel main i messaggi `transition`, e
  rimettere lo snapshot persistito nel comando `start` alla ripresa.
- **Il cablaggio IPC della verifica provider non è fatto**, di proposito: i
  canali erano territorio di un altro agente. Il flusso previsto è
  `resolveModel` in try/catch, `classifyError(e)` sul fallimento, altrimenti
  `verifyProvider({ backend: sdkBackend(resolved, generateText), modelId })`.
  Vanno aggiunti i canali `providers.*` in `app/shared/channels.ts` e i
  gestori in `app/main/ipc.ts` (la mappa di `buildHandlers`, che un test
  confronta con l'elenco dichiarato).
- **`ai` non è una dipendenza**: `sdkBackend(resolved, generate)` riceve
  `generateText` dall'esterno, e il processo engine lo importa dinamicamente.

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

## Cosa nessuna suite dimostra

- **Nessun test costruisce un backend funzionante**: servirebbe la rete. Un
  errore di cablaggio in `resolve.ts` o `sdk.ts` passerebbe tutti i 411 test.
  Va provato a mano con un provider vero, ed è il rischio numero uno.
- **Font offuscati**: mai passati dalla pipeline. `RSC-004` fa saltare a
  EPUBCheck il contenuto delle risorse cifrate, quindi il fallimento è
  invisibile.
- **Impaginazione fissa**: rilevata e dichiarata, mai risolta.
- **Rimozione degli overlay**: specificata e coperta da un'invariante, mai
  eseguita su un audiolibro vero.
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
