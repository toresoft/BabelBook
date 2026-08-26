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
| 4. Esecuzione, provider, composizione | **completo**, 9/9 | `app/main/providers/`, `app/engine/`, `app/main/run/`, `app/main/compose.ts`, `core/workflow/` |
| 5. Gate, glossari, report | **task 1-5 su 8** | `app/main/terms/`, `app/main/exclusions/`, `app/main/glossaries/`, `app/main/report/` |

Suite: **482 test verdi** (260 core, 222 app) piu' **7 prove end-to-end**, di
cui due portano un libro intero dal file all'EPUB tradotto e ne mettono in pausa
uno a meta'. Typecheck e build di produzione sono puliti.

## Il prossimo passo

**Piano 5, Task 6** — le schede del progetto. Il lavoro del main e' finito:
approvazione dei termini, invalidazione con anteprima, revisione delle
esclusioni, glossari, report, tutto raggiungibile via IPC. Restano tre
schermate: le schede del progetto (6), le impostazioni (7), i due gate
dall'inizio alla fine (8).

Quello che l'applicazione fa oggi: crea un progetto da un EPUB, mostra la
libreria, **traduce un libro intero** con pausa e ripresa che non ritraducono
nulla, compone l'EPUB con il suo gate, e da `/settings` si aggiunge un provider
con la sua chiave. Cio' che manca all'utente e' vedere e decidere: i due gate
oggi si attraversano solo con l'auto-accettazione.

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
  errore di cablaggio in `resolve.ts` o `sdk.ts` passerebbe tutti i 482 test.
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
