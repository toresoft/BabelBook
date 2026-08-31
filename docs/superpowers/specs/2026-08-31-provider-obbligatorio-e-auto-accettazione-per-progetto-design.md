# Provider obbligatorio e auto-accettazione per progetto — design

**Data:** 2026-08-31
**Stato:** approvato in brainstorming, da tradurre in piano di implementazione

Il documento è in italiano perché in italiano è avvenuta la progettazione.
Codice e commenti restano in inglese.

## Contesto

Tre richieste che sembrano tre e sono due:

1. non deve essere possibile creare un progetto se non c'è almeno un provider
   configurato;
2. scegliere un provider alla creazione e alla modifica di un progetto deve
   essere obbligatorio;
3. l'auto-accettazione dei termini e delle esclusioni diventa una proprietà del
   progetto e non più dell'applicazione, con default `true` per entrambe.

Le prime due sono la stessa invariante detta a due altezze — *un progetto ha un
provider* — vista una volta dalla libreria e una volta dal confine IPC. La terza
è indipendente, e ribalta un default che il codice difende per iscritto.

### Da dove si parte

Oggi il progetto nasce deliberatamente senza provider. Il commento in testa a
`createProject` lo dichiara:

```
 * Every step here is deterministic: [...] A project can be created before any
 * provider is configured, and the counts it produces are what the interface
 * shows the user *before* asking them to pay for a translation.
```
— `app/main/projects/create.ts:66`

L'interfaccia lo asseconda: `new-project.html:74` offre
`<option [value]="null">Nessuno (si può scegliere dopo)</option>`, e il provider
viene scritto più tardi, con una `project.update` che la stessa schermata manda
al «Crea». La colonna `project.provider_id` è nullable
(`001-initial.sql:83`), e la corsa scopre l'assenza soltanto al momento di
partire, in `main.ts:284`, con un `NO_PROVIDER_CONFIGURED` lanciato dentro
`backendSpec`.

Le due auto-accettazioni vivono nella tabella `setting`, lette da `readSettings`
(`ipc.ts:96-97`), esposte come due interruttori globali in
`preferences.html:5-30`, e consegnate alla corsa in due punti: il contesto della
macchina XState (`runtime.ts:92`) e la `RunConfig` (`runtime.ts:388`). Il loro
default è `false`, con la motivazione scritta accanto:

```ts
  // Both gates stop by default. Skipping them is a choice the user makes
  // knowingly; making it for them would spend money on terminology nobody saw.
```
— `app/shared/channels.ts:22`

Non esiste alcuna schermata per modificare un progetto dopo la creazione:
`project.update` è invocata da un solo posto, `new-project.ts:109`.

## Decisioni prese in brainstorming

| Domanda | Risposta |
|---|---|
| Dove si ferma chi non ha provider | Bottone «Nuovo progetto» disabilitato in libreria, più una guardia lato main |
| Quando si sceglie il provider in `/new` | Dopo l'analisi, dov'è ora — ma senza l'opzione «Nessuno» e con «Crea» disabilitato |
| «Modifica di un progetto» | Serve una schermata nuova: provider, modello, lingue, descrizione, i due interruttori |
| Progetti già in libreria | Ereditano il valore globale di oggi, non il nuovo default |
| Progetti già orfani di provider | La colonna resta nullable; l'invariante vive al confine |
| I due interruttori | Visibili sia alla creazione sia nella modifica |

## Approccio

Due colonne su `project`, lette all'avvio della corsa. Le due proprietà stanno
dove lo schema tiene già i fatti di un libro — accanto a `provider_id` e
`target_language` — e `makeRunRuntime` le legge dalla riga che interroga
comunque, invece che da `deps.settings()`.

Le due alternative sono state scartate:

- **tenerle in `setting` come «valore con cui nasce un progetto nuovo»** —
  costa meno codice, ma lascia in piedi due interruttori globali che governano
  libri già creati, cioè esattamente ciò che va tolto;
- **una tabella `project_setting` chiave/valore** — generica per ogni futura
  impostazione per progetto, ma due booleani non ripagano un join a ogni
  lettura, e nessun'altra proprietà del progetto è modellata così.

## Sezione 1 — Lo schema

Migrazione `015-project-auto-accept.sql`:

```sql
ALTER TABLE project ADD COLUMN auto_accept_terms INTEGER NOT NULL DEFAULT 1
  CHECK (auto_accept_terms IN (0, 1));
ALTER TABLE project ADD COLUMN auto_accept_exclusions INTEGER NOT NULL DEFAULT 1
  CHECK (auto_accept_exclusions IN (0, 1));

-- I libri già in libreria tengono il comportamento che avevano ieri. Assente
-- vuol dire false: è così che readSettings lo leggeva, e la DEFAULT 1 vale per
-- i progetti che ancora non esistono.
UPDATE project SET
  auto_accept_terms      = CASE WHEN (SELECT value FROM setting WHERE key = 'autoAcceptTerms')      = 'true' THEN 1 ELSE 0 END,
  auto_accept_exclusions = CASE WHEN (SELECT value FROM setting WHERE key = 'autoAcceptExclusions') = 'true' THEN 1 ELSE 0 END;

DELETE FROM setting WHERE key IN ('autoAcceptTerms', 'autoAcceptExclusions');
```

L'`UPDATE` è incondizionato di proposito: quando la riga in `setting` manca, il
`CASE` dà `0`, che è il valore che `readSettings` restituiva per una chiave
assente. Un libro a metà corsa che si fermava ai gate continua a fermarsi.

`provider_id` **resta nullable**. Nessuna migrazione sceglie un modello al posto
dell'utente, e su un database senza provider una migrazione che pretendesse di
riempire i vuoti non potrebbe nemmeno girare. Il commento della migrazione deve
dirlo: l'invariante «un progetto ha un provider» vive al confine, non nello
schema, e una colonna nullable letta fra sei mesi senza quel commento si legge
come «il provider è facoltativo».

## Sezione 2 — Il contratto e le guardie

In `app/shared/dto.ts`:

- `CreateProjectRequest.providerId` e `.modelId` diventano obbligatori
  (`string`, non `string?`);
- `UpdateProjectRequest` guadagna `autoAcceptTerms?: boolean` e
  `autoAcceptExclusions?: boolean`; `providerId?`/`modelId?` restano opzionali
  *in quanto patch*, ma se presenti non possono essere vuoti;
- `ProjectDetail` guadagna `autoAcceptTerms: boolean` e
  `autoAcceptExclusions: boolean`, che la schermata di modifica legge;
- `Settings` perde i due campi, e con essa `DEFAULT_SETTINGS` in `channels.ts` e
  le due righe di `readSettings` in `ipc.ts:96-97`.

Una funzione sola, nuova, in `app/main/projects/provider.ts`, chiamata sia da
`project.create` sia da `project.update`:

```ts
/** Il provider e il modello esistono davvero, o la richiesta non è una richiesta. */
function assertProviderChosen(db: DatabaseSync, providerId: string, modelId: string): void
```

Rifiuta con codici nominati, mai con frasi — la stessa regola che `run_event`
segue per le degradazioni:

| Codice | Quando |
|---|---|
| `PROVIDER_REQUIRED` | `providerId` o `modelId` mancante, `null` o stringa vuota |
| `UNKNOWN_PROVIDER` | nessuna riga in `provider` con quell'id |
| `UNKNOWN_MODEL` | nessuna riga in `provider_model` per quella coppia |

L'unicità `(provider_id, model_id)` è già nello schema
(`012-model-reasoning-level.sql:23`), quindi la terza verifica è una `SELECT`
sola.

`project.create` la chiama **prima di toccare il disco**. Un EPUB copiato in uno
spazio di lavoro per un progetto poi rifiutato è la mezza-ingestione che
`create.ts:75` dichiara di non voler mai lasciare dietro di sé.

In `project.update` c'è una trappola: la `UPDATE` usa
`coalesce(?, provider_id)` (`ipc.ts:283`), quindi oggi un `providerId: ""`
scriverebbe la stringa vuota e un `null` non cancellerebbe nulla. Con la guardia
davanti, `""` viene rifiutato e `undefined` continua a significare «non
toccare», che è il comportamento giusto per una patch.

## Sezione 3 — La libreria

`Library` carica `providers.list` accanto ai progetti e tiene:

```ts
readonly canCreate = computed(() => this.providers().some((p) => p.models.length > 0));
```

Non basta *un provider*: un provider senza modelli non permette di scegliere un
modello, e un bottone acceso che porta a un modulo impossibile da compilare è
peggio di uno spento.

Si riascolta su `providers.changed`, l'evento che il main già trasmette quando
un provider viene connesso o modificato, così tornando dalle impostazioni il
bottone si riaccende senza riavviare la finestra.

Quando `canCreate()` è falso, il `routerLink` di `library.html:11` diventa un
`<button disabled>`, con sotto una riga sola — chiave `library.needsProvider` —
e un link a `/settings/providers`. Il testo dice cosa manca e dove si aggiunge,
non «non puoi».

## Sezione 4 — Nuovo progetto

- Sparisce `<option [value]="null">` (`new-project.html:74`) e con essa la chiave
  `newProject.noProvider`.
- `loadProviders()` preseleziona il primo provider che ha modelli, e con esso il
  primo modello; `pickProvider` (`new-project.ts:71`) fa già metà del lavoro.
  La preselezione non è cosmetica: `choose()` chiama `project.create`
  **subito dopo la scelta del file**, e ora quella chiamata porta `providerId` e
  `modelId`. La riga non nasce mai senza. La scelta fatta nel modulo resta
  libera e arriva a destinazione con la `project.update` del «Crea», come oggi.
- Due `checkbox`, accesi, sotto la descrizione, per le due auto-accettazioni;
  viaggiano nella stessa `project.update`.
- «Crea» è disabilitato finché provider o modello sono vuoti. È una difesa
  dell'interfaccia, non l'unica: il rifiuto vero è quello del main.
- Chi arriva su `/new` a mano con zero provider vede la stessa riga della
  libreria e non gli viene offerto «Scegli un EPUB».

Di riflesso migliora anche la stima (`new-project.ts:47`): con un modello sempre
scelto, il messaggio `newProject.noPrices` smette di comparire per il motivo
sbagliato («nessun modello scelto») e resta solo per quello giusto — il modello
non dichiara prezzi.

## Sezione 5 — La modifica di un progetto

Un `bb-detail` come quello che già mostra la descrizione (`side.html:219`),
aperto da un `btn btn-xs` accanto ai fatti della colonna, con testid
`side-edit`. Componente nuovo `app/renderer/src/app/project/side/project-settings.ts`
e `.html`, fratello di `progress-panel`.

Contiene: provider, modello, lingua di destinazione, lingua di partenza,
descrizione, e i due interruttori. Salva con una sola `project.update` e chiude:
il ricaricamento arriva da sé, perché `project.ts:89` è già in ascolto su
`project.changed`.

Due regole:

**Il bottone è spento solo mentre il motore è vivo**, cioè negli stati
`running` e `composing`. Cambiare modello sotto un motore che sta traducendo non
è una modifica, è una domanda a cui il sistema non ha risposta. Negli stati
sospesi — `paused`, `waiting-terms`, `waiting-code` — resta acceso: lì la
modifica è legittima, ed è esattamente il momento in cui uno cambia idea sul
modello. Ciò che protegge il lavoro fatto è la conferma, non il bottone spento.

**Una modifica che cambia il contratto della cache chiede conferma se c'è
lavoro fatto.** La `cache_key` è ricalcolata a ogni avvio da `projectCacheKey`
(`cache-key.ts:17`), e tre dei campi di questa schermata vi entrano: il
**modello**, la **lingua di partenza** e la **lingua di destinazione**. Cambiare
uno qualunque dei tre lascia le traduzioni già pagate sul disco ma smette di
contarle. Serve una `ConfirmKind` nuova in `channels.ts:41` — `contractChange`,
nominata sul fatto e non su uno dei tre campi — con un messaggio parallelo a
quello che `reasoningChange` porta già per la stessa ragione, e che nomina quale
dei tre sta cambiando.

Il provider da solo non entra nella chiave: `projectCacheKey` riceve `modelId`,
non l'endpoint. Cambiare provider tenendo lo stesso modello non chiede nulla, e
non deve.

La conferma appare **solo** se il progetto ha traduzioni sotto la chiave
corrente: senza lavoro fatto non c'è niente da perdere, e la domanda sarebbe
rumore. È anche il motivo per cui `/new` non ne ha bisogno — lì la chiave non
esiste ancora.

## Sezione 6 — La corsa

`RunRuntimeDeps.settings()` si restringe a `{ concurrency: number }`
(`runtime.ts:22`). La `SELECT` di `project()` (`runtime.ts:83`) aggiunge le due
colonne all'interfaccia `ProjectRow`; `machineHost()` (`runtime.ts:92`) e la
costruzione della `RunConfig` (`runtime.ts:388`) le leggono da lì.

`RunConfig` **non cambia forma**: cambia solo da dove arrivano i due valori.
Quindi l'engine, l'orchestratore e la macchina XState restano intatti, e `core/`
non si tocca affatto.

## Sezione 7 — Le preferenze

Via i due `checkbox` da `preferences.html:5-30`; la sezione «Traduzione» resta
con `concurrency`. Le chiavi `prefs.autoAcceptTerms`, `prefs.autoAcceptTermsHint`,
`prefs.autoAcceptExclusions` e `prefs.autoAcceptExclusionsHint` si spostano sotto
`newProject.` e `project.`, riscritte per un lettore che le incontra davanti a
un libro e non davanti all'applicazione — in entrambi i cataloghi, `it.json` e
`en.json`.

Il commento in `channels.ts:22` va **riscritto, non cancellato**. Dice una cosa
vera — spendere su terminologia che nessuno ha visto — e la risposta nuova è che
la scelta è per libro e visibile in faccia a chi crea, non sepolta nelle
preferenze dell'applicazione.

## Sezione 8 — I test

Nuovi:

- la migrazione copia il valore globale sui progetti esistenti, e sceglie `0`
  quando la riga in `setting` è assente;
- `project.create` rifiuta senza provider **e non lascia spazio di lavoro sul
  disco**;
- `project.update` rifiuta `""` e un id inesistente, e `undefined` continua a
  non toccare nulla;
- il runtime legge le due proprietà dalla riga del progetto e non dalle
  impostazioni;
- la libreria spegne il bottone quando nessun provider ha modelli, e lo
  riaccende su `providers.changed`;
- `/new` non offre «Nessuno», preseleziona, e disabilita «Crea»;
- la schermata di modifica salva; chiede conferma quando cambia modello o una
  delle due lingue **e** ci sono traduzioni sotto la chiave corrente; non chiede
  nulla quando cambia il solo provider; è spenta in `running` e `composing` e
  accesa in `paused`.

Da correggere, non da riscrivere — la `RunConfig` è la stessa, cambia chi la
costruisce: `ipc.test.ts:132`, `engine-host.test.ts:49`, `orchestrator.test.ts:34`,
`preferences.spec.ts`, `settings.spec.ts:15`, `app.config.spec.ts:11`,
`e2e/settings.spec.ts:62`.

**Il caso da guardare per primo** è `e2e/gates.spec.ts:79`. Dice:

```
  // Both gates are on by default, so the run stops and asks.
```

Con questa modifica quella frase diventa falsa. Il test va reso esplicito — crea
il progetto e spegne le due auto-accettazioni prima di avviare — altrimenti
passa verificando il contrario di ciò che afferma di verificare.

## Fuori scopo

- Invalidare o cancellare le traduzioni quando il modello cambia. La
  `cache_key` le rende semplicemente inattive, che è il comportamento attuale e
  quello giusto: il lavoro resta sul disco se si torna al modello di prima.
- Un default per progetto configurabile («i nuovi progetti nascono così»). Il
  default è `true`, scritto nello schema, e cambiarlo è una richiesta che
  ancora nessuno ha fatto.
- Rendere `provider_id` `NOT NULL` in una migrazione futura. Diventa possibile
  una volta che nessun database in giro ha più righe orfane; oggi non lo
  sappiamo, e non è questo il piano che lo scopre.
