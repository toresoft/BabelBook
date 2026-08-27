# La schermata dei provider — design

**Data:** 2026-08-27
**Stato:** approvato in brainstorming, da tradurre in piano di implementazione

Il documento è in italiano perché in italiano è avvenuta la progettazione.
Codice e commenti restano in inglese.

## Contesto

La schermata dei provider fa tre cose in una colonna sola: elenca i provider
configurati, offre una ricerca per aggiungerne uno, e apre un modulo di
creazione sotto entrambe. Funziona, e si legge male.

Il disordine ha un'origine precisa, e non è il CSS. Il modulo ha quattro modi —
`kind: "catalog" | "local" | "compatible" | "edit"` — e il template si dirama su
ciascuno:

```html
@if (form.kind === 'compatible' || form.kind === 'edit') { … }
@if (form.kind === 'compatible') { … }
@if (form.kind !== 'local') { … }
@if (form.kind === 'catalog') { … }
@if (form.kind === 'catalog' && form.baseUrl !== null) { … }
```

Cinque condizioni su quattro modi, per chiedere in fondo due cose: una chiave e,
qualche volta, un indirizzo. Il modulo sa troppe cose perché sta facendo due
lavori insieme — collegare un provider e scegliere un modello — e ogni
combinazione dei due gli costa un ramo.

Attorno, la ricerca restituisce pastiglie con il solo nome, e «Endpoint
compatibile» è un pulsante-preset a fianco: una modalità speciale accanto a una
lista, invece di una voce dentro la lista.

### Il modello: opencode desktop

Il riferimento indicato è la gestione provider di **opencode desktop**, non del
suo programma da terminale. Le sue mosse, dalle schermate:

1. **Provider connessi** in cima, come sezione propria e corta; **provider più
   diffusi** sotto.
2. I diffusi sono una **lista corta e nominata**, non una ricerca su duecento
   voci.
3. Ogni voce **si spiega in una riga** — *«Accesso diretto ai modelli Claude,
   inclusi Pro e Max»*.
4. **Connettere è un atto a sé**, in una modale con la propria ricerca e i
   risultati raggruppati in «Popolari» e «Altro».
5. **Il provider personalizzato è una voce della lista**, sotto «Altro», con la
   sua etichetta. Non una modalità.
6. Un'etichetta sul provider connesso dice **come** è autenticato («Chiave API»).
7. Il verbo è **«Disconnetti»**, non «Elimina».

La sua colonna di sinistra raggruppa le voci sotto intestazioni — Desktop,
Server — che è la stessa forma decisa per il guscio in
`2026-08-27-guscio-e-libreria-design.md`, raggiunta per ragioni indipendenti.

### Quello che non si copia

Il catalogo di babelBook — che è models.dev, la stessa fonte che usa opencode —
porta **sei campi per provider**: `api`, `env`, `id`, `models`, `name`, `npm`.
Contati sullo snapshot incluso:

```
description  presente in 0 provider su 203
icon         presente in 0 provider su 203
popular      presente in 0 provider su 203
```

Le frasi di spiegazione, le icone e la lista dei «più diffusi» **non vengono dal
catalogo: opencode se le è scritte**. Copiare l'impaginazione senza il testo
darebbe la stessa struttura con dei nomi nudi e uno spazio bianco dove dovrebbe
esserci la spiegazione — peggio di oggi, non meglio.

Da qui la decisione sul testo: poche frasi scritte dove contano, e per tutti gli
altri una riga **derivata dai dati**, che è vera per costruzione e non invecchia.

## Obiettivi

- Ciò che è già collegato si distingue a colpo d'occhio da ciò che si può
  aggiungere.
- Collegare un provider e scegliere un modello sono due atti separati, e il
  modulo perde i suoi quattro modi.
- Un provider si sceglie sapendo qualcosa di lui, non solo il nome.
- Il provider personalizzato smette di essere un'eccezione e diventa una voce.

## Non obiettivi

- **Le icone.** opencode ne spedisce un paio di centinaia; qui non esiste un set
  e il guscio ha già deciso di non introdurne. Le voci portano nome e riga.
- **OAuth e abbonamenti.** «OpenCode Zen», «GitHub Copilot», «ChatGPT Plus» sono
  flussi che babelBook non ha mai avuto: il design originale dice *«solo API»*.
  Non è una mancanza di questa schermata.
- **Descrizioni per tutti e 203.** Sarebbero 406 stringhe in due lingue, e ogni
  frase è una cosa che può diventare falsa senza che nessuno se ne accorga.
- Modifiche al catalogo, al suo aggiornamento o alla risoluzione dei pacchetti.
  Sono il lavoro A.

## Decisioni

| Questione | Decisione |
|---|---|
| Forma della schermata | Due sezioni: «Provider connessi», poi «Aggiungi un provider» |
| Dove si sceglie | In una modale «Connetti provider», con ricerca e gruppi |
| I gruppi della modale | Sulla tua macchina · Popolari · Altro |
| Il provider personalizzato | Una voce sotto «Altro», con etichetta — non un pulsante-preset |
| I quattro `kind` del modulo | Spariscono: collegare chiede sempre le stesse due cose |
| Scegliere il modello | Secondo atto, sulla scheda del provider connesso |
| Testo redazionale | Una frase per i dieci diffusi, in entrambe le lingue |
| Tutti gli altri | Riga derivata dal catalogo: numero di modelli e variabile di chiave |
| Il verbo distruttivo | «Disconnetti»; `confirm.deleteProvider.message` e `providers.delete` si riscrivono di conseguenza in entrambe le lingue |
| Il campo `env` | Usato, ma mai come meccanismo su cui contare |

## La schermata

**«Provider connessi»**, in cima e corta. Una scheda per provider configurato:
il nome, un'etichetta che dice come è autenticato — *Chiave API*, *Nessuna
chiave*, *Locale* — il modello in uso, e le azioni **Verifica**, **Modifica**,
**Disconnetti**.

Quando non ce n'è nessuno la sezione non è vuota con una frase triste: è
assente, e la schermata è tutta «Aggiungi un provider».

**«Aggiungi un provider»**, sotto. I dieci diffusi con la loro frase, e una voce
che apre la modale per cercare fra tutti.

I dieci compaiono quindi due volte: qui e dentro la modale, sotto «Popolari». È
deliberato, ed è ciò che fa il modello. Servono a due cose diverse: in pagina
sono la via breve — si collega Anthropic senza aprire niente; nella modale sono
ciò che impedisce alla ricerca di aprirsi su un muro di duecento nomi in ordine
alfabetico.

## La modale «Connetti provider»

Un campo di ricerca in cima, e i risultati in tre gruppi.

**Sulla tua macchina.** Ollama e LM Studio, quando stanno girando. babelBook li
scopre già da solo (`probeLocalRuntimes`), ed è una cosa che il modello non fa.
Stanno **sopra** i popolari, perché sono l'unico gruppo che non chiede una
chiave a nessuno: chi ha un modello sulla propria macchina deve trovarlo per
primo, non dopo otto servizi a pagamento.

**Popolari.** I dieci, con la frase scritta a mano:

| id | nome | modelli |
|---|---|---|
| `anthropic` | Anthropic | 13 |
| `openai` | OpenAI | 47 |
| `google` | Google | 39 |
| `openrouter` | OpenRouter | 355 |
| `mistral` | Mistral | 34 |
| `groq` | Groq | 15 |
| `xai` | xAI | 12 |
| `deepseek` | DeepSeek | 3 |
| `togetherai` | Together AI | 36 |
| `cerebras` | Cerebras | 2 |

La lista è scritta nel codice, non nel catalogo, e questo è deliberato: è un
fatto su cosa questa applicazione consiglia, non su cosa il catalogo contiene —
la stessa ragione per cui `routeDefaults` vive in `providers/store.ts` e non
in models.dev.

**Altro.** La coda, in ordine alfabetico, ciascuna voce con la riga derivata:

> Anthropic · 13 modelli · `ANTHROPIC_API_KEY`

Sono dati che il catalogo ha già. Il numero di modelli viene da `models.length`;
il nome della variabile da `env`, che è un array — `google` ne dichiara tre — e
di cui si mostra il primo.

Nella coda sta anche **«Provider personalizzato compatibile con OpenAI»**, con
la sua etichetta. È lì che «Endpoint compatibile» smette di essere un pulsante a
parte: chi lo cerca lo trova dove cerca tutti gli altri.

I provider che il lavoro A marca come non servibili restano visibili e non
selezionabili, come quel design stabilisce.

## Connettere non è scegliere

È il cambiamento che porta via il disordine.

**Collegare** chiede al massimo due cose: una chiave, e un indirizzo quando il
catalogo non ne conosce uno. Quale delle due venga chiesta è una **proprietà del
provider** — ha un `api`? ha un `env`? — non un modo del modulo. I quattro
`kind` e le cinque condizioni del template spariscono con essi.

**Scegliere il modello** è un secondo atto, sulla scheda del provider ormai
collegato, dove i modelli esistono davvero perché la chiave c'è. Oggi invece il
modulo chiede la chiave, poi offre «Trova modelli», poi una select — e finché
non si è finita la sequenza non si è ottenuto niente.

Il modo `edit` diventa lo stesso atto di collegare, su un provider che esiste
già.

## Il campo `env`

`shape.ts:145` lo parsa per tutti e 203 i provider, `CatalogProvider` lo
tipizza, e `toEntry` lo scarta: nessuno lo ha mai usato. Quando la variabile è
presente nell'ambiente, la scheda lo dice e offre di usarla invece di chiedere
di incollare una chiave.

**Il limite, che va scritto e non aggirato:** un'applicazione Electron avviata
dal menu applicazioni su Linux non eredita l'ambiente della shell — una
`.desktop` parte con un ambiente minimo, e una chiave esportata in `.bashrc` lì
non esiste. Funziona lanciando l'applicazione da un terminale, e spesso non
altrimenti.

Quindi: è un regalo quando c'è, mai un meccanismo. L'interfaccia non dice mai
«manca la variabile d'ambiente» — dice «serve una chiave», e semmai aggiunge
«ne ho trovata una nell'ambiente, la uso?». La precedenza è chiave salvata →
variabile d'ambiente → chiedere.

## Cosa si prova

- **I gruppi della modale.** Che i motori locali precedano i popolari e i
  popolari la coda, con dei runtime finti iniettati: è l'ordine che porta il
  significato, e un test sull'ordine è l'unico modo di tenerlo.
- **La riga derivata.** Che per un provider qualunque del catalogo dica il vero
  numero di modelli e la prima delle sue variabili — su `google`, che ne
  dichiara tre, e su un provider che ne dichiara una.
- **I dieci esistono.** Che ogni id della lista dei popolari sia presente nello
  snapshot incluso, e che ognuno abbia la sua frase in **entrambe** le lingue.
  Impedisce che un aggiornamento del catalogo tolga di sotto un consigliato
  senza che nessuno se ne accorga.
- **Il personalizzato è una voce.** Che compaia nei risultati della modale e non
  come pulsante separato.
- **Collegare non sceglie.** Che il modulo di collegamento non chieda mai un
  modello, e che la scelta del modello avvenga su un provider che ha già una
  chiave.
- **La chiave non arriva mai alla finestra.** È già vero e va tenuto vero: la
  chiave si scrive, non si rilegge. I test esistenti su questo non si toccano.
- **Le schermate, in entrambi i temi.** `screens.spec.ts` cattura già
  `settings-providers`; le sue immagini vanno rigenerate e guardate.

## Rischi

**I dieci consigliati sono un'opinione, e le opinioni invecchiano.** Fra un anno
qualcuno di loro potrebbe non essere più una buona prima scelta. Il test che
verifica la loro presenza nel catalogo non dice niente sulla loro bontà: quella
resta una decisione umana da rivedere ogni tanto, e va bene così — è il prezzo
di avere una schermata che consiglia invece di limitarsi a elencare.

**La riga derivata mostra un numero che cambia.** «355 modelli» per OpenRouter è
vero allo snapshot di oggi e sarà un altro numero dopo un aggiornamento. È
corretto: è quello il senso di derivarlo invece di scriverlo.

**Il conteggio dei modelli non è una misura di qualità.** Un provider con 355
modelli non è migliore di uno con 3. La riga informa, non classifica, e l'ordine
dei popolari non deve seguirlo.

## Ordine e dipendenze

Questo lavoro viene **dopo** entrambi gli altri.

Dopo **B1**, perché la modale, le schede e le etichette sono componenti daisyUI:
farli prima significherebbe scriverli due volte.

Dopo **A**, perché la marcatura dei provider non servibili vive esattamente in
questa lista, e perché `CatalogEntry.route` diventa nullabile lì.
