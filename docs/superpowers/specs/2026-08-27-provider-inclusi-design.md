# Provider inclusi — design

**Data:** 2026-08-27
**Stato:** approvato in brainstorming, da tradurre in piano di implementazione

Il documento è in italiano perché in italiano è avvenuta la progettazione.
Codice e commenti restano in inglese.

## Contesto

L'applicazione offre 203 provider e non riesce a chiamarne nessuno. Chi
configura un provider e preme Verifica legge *«Il pacchetto della rotta non è
installato su questa macchina»* (`verify.package-missing`), e non ha modo di
rimediare: in un'app impacchettata non esiste una riga di comando dove
installare qualcosa.

Non è un difetto: è una scelta, dichiarata in `app/engine/backends/resolve.ts`
— *«The provider packages are the user's to install»* — presa quando lo stesso
codice poteva ancora essere usato da uno sviluppatore con un `node_modules`
suo. Per un'applicazione che si distribuisce come `.deb`, `.rpm`, AppImage e
NSIS quella premessa non regge più. Questo documento la ribalta.

Sotto ci sono due guasti distinti, ed è importante non confonderli.

**Primo: nessun pacchetto è spedito.** Né `ai` né alcun `@ai-sdk/*` compare
fra le dipendenze di `app/package.json`. Ogni provider fallisce, sempre.

**Secondo: undici provider non funzionerebbero comunque.** `resolveModel`
compone il nome del pacchetto come `@ai-sdk/${route}`, mentre `routeOf` ricava
la rotta togliendo il solo prefisso `@ai-sdk/`. Per i pacchetti di terze parti
il giro non torna:

- sei rotte (`@openrouter/ai-sdk-provider`, `@qvac/…`, `@saladtechnologies-oss/…`,
  `@jerome-benoit/…`, `@aihubmix/…`, `google-vertex/anthropic`) contengono `@`
  o `/`, che il regex `ROUTE` rifiuta → `bad-spec`;
- cinque (`venice-ai-sdk-provider`, `gitlab-ai-provider`, `watsonx-ai-provider`,
  `merge-gateway-ai-sdk-provider`, `ai-gateway-provider`) passano il regex ma
  fanno cercare `@ai-sdk/venice-ai-sdk-provider` e simili, che non esistono →
  `package-missing` per sempre.

Installare i pacchetti risolve il primo guasto e non il secondo.

### Il criterio che conta davvero

Non è quale pacchetto, ma **quale versione della specifica** parla. `ai@7.0.83`
dipende da `@ai-sdk/provider@4.0.8`. Un pacchetto costruito sulla `3.x`
consegna un oggetto-modello di un'interfaccia diversa: non fallisce all'import,
fallisce alla chiamata. Spedirlo sposta il guasto più avanti anziché toglierlo.

Classificando i 22 pacchetti che il catalogo nomina:

| Specifica | Pacchetti | Provider |
|---|---|---|
| `@ai-sdk/provider@4` — compatibili con `ai@7` | 17 `@ai-sdk/*` + OpenRouter, Qvac, Salad, GitLab, ai-gateway, merge-gateway | **199** |
| `@ai-sdk/provider@3` — incompatibili | Venice, AIHubMix, SAP AI Core, watsonx | **4** |

Il peso non è un argomento: i 24 pacchetti da spedire fanno ~28 MB non
compressi, di cui 6,7 sono `ai` da solo, dentro un runtime Electron da ~180 MB.

## Obiettivi

- Ogni provider del catalogo è chiamabile senza che l'utente installi nulla.
- Un provider che l'applicazione non può servire lo si sa **prima**, nella
  lista, non dopo aver configurato una chiave e premuto Verifica.
- La risoluzione non compone più nomi di pacchetti da stringhe di database.
- Nessuna traduzione già pagata viene invalidata.

## Non obiettivi

- Pacchetti provider di terze parti installati dall'utente. Con l'app
  impacchettata non è mai stato possibile; smettere di prometterlo è parte del
  lavoro.
- Spedire una seconda copia dell'SDK (`ai@6` sotto alias) per i quattro
  pacchetti su specifica vecchia. Due SDK da aggiornare e due percorsi di
  chiamata da mantenere è un costo permanente per due provider su 203, e i
  quattro migreranno comunque a v4.
- Qualunque modifica alla schermata provider, alla Verifica, al catalogo o
  all'interfaccia. Sono lavori separati.
- Modifiche al formato dello spec `route:id`.

## Decisioni

| Questione | Decisione |
|---|---|
| Come arrivano i pacchetti | `dependencies` vere di `app/package.json`, imbarcate da electron-builder |
| Assetto del bundler | Invariato: `packages: "external"` resta |
| Come si trova la factory | Registro esplicito rotta → import statico, in un file solo |
| Chiave del registro | La rotta corta, non il nome del pacchetto |
| Pacchetto sconosciuto con `api` | Servito da `@ai-sdk/openai-compatible` |
| Pacchetto sconosciuto senza `api` | Non servibile, detto nella lista |
| Provider su specifica v3 | Trattati come sconosciuti: ripiego su `openai-compatible` |
| Migrazione del database | Nessuna |

## Il registro

Un file nuovo — `app/engine/backends/registry.ts` — associa ogni rotta al suo
import statico. È l'unico posto dove un nome di pacchetto è scritto, e ciò che
`resolveModel` consulta invece di comporre `@ai-sdk/${route}`.

Le rotte dei 192 provider che oggi risolvono **non cambiano**. Cambia solo cosa
il registro fa con la rotta.

| Rotta | Pacchetto | Provider | Stato |
|---|---|---|---|
| `openai-compatible` | `@ai-sdk/openai-compatible` | 163 | invariata |
| `anthropic` | `@ai-sdk/anthropic` | 9 | invariata |
| `openai` | `@ai-sdk/openai` | 5 | invariata |
| `azure` | `@ai-sdk/azure` | 2 | invariata |
| `google`, `google-vertex`, `mistral`, `groq`, `xai`, `cohere`, `perplexity`, `togetherai`, `cerebras`, `deepinfra`, `vercel`, `gateway`, `amazon-bedrock` | i rispettivi `@ai-sdk/*` | 13 | invariate |
| `google-vertex-anthropic` | `@ai-sdk/google-vertex/anthropic` | 1 | **nuova** |
| `openrouter` | `@openrouter/ai-sdk-provider` | 1 | **nuova** |
| `qvac` | `@qvac/ai-sdk-provider` | 1 | **nuova** |
| `salad` | `@saladtechnologies-oss/ai-sdk-provider` | 1 | **nuova** |
| `gitlab` | `gitlab-ai-provider` | 1 | **nuova** |
| `ai-gateway` | `ai-gateway-provider` | 1 | **nuova** |
| `merge-gateway` | `merge-gateway-ai-sdk-provider` | 1 | **nuova** |

24 voci di registro, servite da 23 pacchetti più `ai`: `google-vertex-anthropic`
è un sottopercorso di un pacchetto già presente, non un pacchetto in più.

`routeOf` smette di essere una funzione di stringhe e diventa una ricerca nel
registro per nome di pacchetto, con il ripiego descritto sotto.

### Perché le rotte restano corte

La rotta finisce **verbatim** nella chiave di cache delle traduzioni: lo spec
`openai:gpt-5` è il `modelId` che identifica ciò che è già stato tradotto.
Cambiare il formato in `@ai-sdk/openai:gpt-5` farebbe ritradurre da capo ogni
progetto in corso, buttando lavoro già pagato. Le sette rotte nuove riguardano
solo provider che non hanno mai tradotto nulla, perché non hanno mai risolto.

Per la stessa ragione la colonna `provider.route` non viene né rinominata né
riscritta, e non serve alcuna migrazione.

## La regola di risoluzione

Una sola, e vale anche per il catalogo che si aggiorna dalla rete e domani può
contenere provider che il registro non conosce:

1. **La rotta è nel registro** → si carica quel pacchetto.
2. **Altrimenti, il catalogo conosce un `api`** → `@ai-sdk/openai-compatible`
   con quell'URL come `baseURL`.
3. **Altrimenti** → il provider non è servibile, e lo si dice nella lista prima
   che venga scelto.

I quattro su specifica v3 cadono nel caso 2. Venice e AIHubMix sono gateway
OpenAI-compatible e funzioneranno davvero. SAP AI Core e watsonx hanno
protocollo e autenticazione propri: potrebbero non rispondere, e in quel caso
lo dice la Verifica — che esiste per questo e costa un clic, non un libro.

La scoperta della factory (`findFactory`) resta com'è: il match caseless sulla
rotta e il ripiego sull'unico `create*` esportato coprono già le forme note. Non
si assume che basti: il test che carica tutte e 24 le voci lo dimostra.

## Errori

`PACKAGE_MISSING` esce dai percorsi che un utente può raggiungere. Dopo questo
lavoro può accadere solo se registro e `package.json` divergono — un errore di
build, non uno stato dell'utente — e un test lo impedisce.

Il caso 3 della regola ha bisogno di un codice proprio, distinto da
`package-missing`: non è un pacchetto assente su questa macchina, è un provider
che questa applicazione non serve. Si chiama **`unsupported-provider`**, entra
in `VerifyCode` (`app/shared/dto.ts`) accanto ai sei esistenti, e le sue
stringhe vanno in `en.json` e `it.json` sotto `verify.`.

`package-missing` resta nel tipo: descrive ancora uno stato reale — registro e
`package.json` che divergono — e toglierlo renderebbe muto quel guasto.

## Come lo provo

- **Copertura del catalogo:** ogni `npm` delle 203 voci dello snapshot incluso
  trova o una voce di registro o un `api` per il ripiego. Impedisce che il
  catalogo cresca un provider che l'app non sa servire.
- **Il registro carica:** `resolveModel` importa davvero ciascuna delle 24 voci
  e ne ricava una factory. Import veri, nessuna rete. È il test che dimostra
  che `findFactory` regge sui sei pacchetti di terze parti.
- **Il ripiego:** pacchetto sconosciuto con `api` → `openai-compatible` su
  quell'URL; senza `api` → rifiuto onesto col codice nuovo.
- **Le rotte non si muovono:** le rotte dei 192 provider che già risolvevano
  sono identiche a prima, perché la cache dipende da quelle.
- **Il pacchetto:** `app/e2e/packaged.spec.ts`, che apre il pacchetto costruito
  e gli fa leggere un libro. È l'unica prova che i pacchetti siano dentro il
  `.deb` e non solo in `node_modules`. Gira già in `release.yml` su Linux e
  Windows con `BABELBOOK_PACKAGED` impostato; salta in `ci.yml` e nel run
  locale, dove nessuno lo imposta. Questo lavoro non aggiunge un test: sposta
  peso su uno che esiste, e il suo esito va guardato prima di dire fatto.
- Il backend finto resta com'è: nessun test raggiunge la rete o spende nulla.

## Rischi

**I sei pacchetti di terze parti sono manutenzione altrui.** Cinque sono stati
aggiornati nelle ultime due settimane, ma nessuno è di Vercel. Se uno si rompe
o resta indietro sulla specifica, il suo provider ricade sul ripiego. Il test
che carica tutte le voci lo fa scoprire alla build, non all'utente.

**`merge-gateway-ai-sdk-provider` dichiara `@ai-sdk/provider-utils@^4`** mentre
`ai@7` porta la `5`. Il peer su `@ai-sdk/provider` è `>=2.0.0`, quindi npm non
protesta, ma la coerenza non è garantita come per gli altri cinque. Se il test
di caricamento lo boccia, va nel gruppo del ripiego.

**Il peso del pacchetto cresce di ~28 MB non compressi.** Accettato.

## Cosa resta aperto

SAP AI Core e watsonx potrebbero esporre un endpoint OpenAI-compatible che
renderebbe il ripiego una soluzione vera anziché un tentativo. Non è stato
verificato: si scoprirà alla prima Verifica di chi li usa. Se non lo espongono,
la strada resta la seconda copia dell'SDK, scartata qui per costo.
