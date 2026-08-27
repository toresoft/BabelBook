# Il guscio e la libreria — design

**Data:** 2026-08-27
**Stato:** approvato in brainstorming, da tradurre in piano di implementazione

Il documento è in italiano perché in italiano è avvenuta la progettazione.
Codice e commenti restano in inglese.

## Contesto

L'applicazione ha quattro schermate e nessuna navigazione. `app.html` è, per
intero:

```html
<router-outlet />
```

Quattro rotte piatte — `/`, `/new`, `/project/:id`, `/settings` — si
sostituiscono a vicenda a tutto schermo. Non esiste niente che resti in piedi
fra l'una e l'altra, e da questo discendono tre difetti che sembrano separati e
non lo sono.

**Da «Nuovo progetto» non si torna indietro.** Il pulsante Annulla esiste, ma
sta dentro il blocco `@if (found)` di `new-project.html:110`: compare solo
*dopo* che un EPUB è stato scelto e analizzato. Chi entra nella schermata e
cambia idea non ha nessuna uscita.

**Un progetto non si può eliminare.** L'handler `project.delete` esiste, il
kind di conferma `deleteProject` esiste ed è tradotto in entrambe le lingue,
`deleteWorkspace` sa perfino salvare l'EPUB tradotto prima di cancellare. Nulla
di tutto ciò ha un chiamante: `library.html` non ha l'azione.

**Il libro tradotto vive solo dentro lo spazio di lavoro.** Dal report lo si
può aprire nel lettore di sistema, non spostare. L'unico modo di metterlo al
sicuro è copiarlo a mano — che è ciò che l'autore ha fatto finora.

C'è poi il difetto che li contiene tutti: **undici stati e nessun modo di
vederli**. Un progetto può essere `new`, `needs-language`, `ready`, `running`,
`waiting-terms`, `waiting-code`, `composing`, `paused`, `done`, `incomplete` o
`failed`, e la libreria li mostra tutti mescolati in una griglia, ognuno con la
sua etichetta. Due di quegli stati sono i soli in cui il progetto **non si
muoverà mai da solo**: ai due gate aspetta un'approvazione umana. Oggi non
hanno un posto dove farsi trovare.

### Due mali, due cure

La richiesta iniziale — *«interfaccia caotica nonostante sia semplice»* —
proponeva due rimedi nello stesso respiro: una libreria di componenti e una
colonna a sinistra. Curano cose diverse, e vale la pena tenerlo presente mentre
si misura il risultato.

La libreria cura l'**incoerenza dei controlli**, che è reale e misurabile: su
52 pulsanti del renderer, 6 portano una classe `.btn` e 46 sono controlli nativi
del sistema. In una stessa riga di azioni convivono due altezze e due sfondi.

La colonna cura l'**architettura dell'informazione**, ed è quella che risponde
alla parola «caotica». Nessuna delle due sostituisce l'altra.

## Obiettivi

- Un guscio che non se ne va mai: la navigazione resta in piedi sotto ogni
  schermata.
- Gli undici stati raccolti in cinque voci, ciascuna col suo conteggio, e i due
  gate con una voce propria.
- Un progetto si elimina.
- Il libro tradotto si esporta senza doversi eliminare il progetto attorno.
- I controlli sono coerenti per costruzione, non per diligenza.

## Non obiettivi

- La schermata di gestione provider. È il lavoro C, e ha un modello suo da cui
  prendere spunto.
- Qualunque cosa riguardi i pacchetti dell'SDK. È il lavoro A, già pianificato.
- Un set di icone. daisyUI non ne porta, e la colonna non ne ha bisogno: cinque
  voci con un nome e un numero si leggono meglio di cinque simboli da imparare.
- Il tema chiaro/scuro come scelta dell'utente. Resta ciò che è: quello di
  sistema, riferito dal processo principale.

## Decisioni

| Questione | Decisione |
|---|---|
| Fondazione degli stili | Tailwind CSS 4 + daisyUI 5, entrambi MIT |
| Comportamenti (focus, overlay, tastiera) | `@angular/cdk` headless, dove e quando servono |
| Forma della navigazione | Guscio persistente: colonna a sinistra, pannello a destra |
| Le voci dei progetti | Cinque: Progetti, Da approvare, In corso, In pausa, Conclusi |
| Dove si filtra | In SQL, dentro `listProjects` |
| Le sezioni delle impostazioni | Nella colonna; la striscia di tab dentro Impostazioni sparisce |
| Il ritorno da «Nuovo progetto» | Non si corregge: smette di poter esistere |
| Il libro tradotto | Azione «Esporta» propria, disponibile appena esiste |
| Il tema | Da `.theme-dark` su `:root` a `data-theme` su `:root` |

### Perché daisyUI e non una libreria di componenti Angular

PrimeNG 22 non è più MIT: porta `@primeui/license-manager`, richiede una chiave
di licenza verificata offline e il rinnovo annuale, e una chiave scaduta *«may
cause the software to display a license notice»*. Per un'applicazione
distribuita come `.deb`, `.rpm` e AppImage significa un obbligo che sopravvive
allo sviluppo e può manifestarsi su macchine altrui. Escluso.

Angular Material è MIT e sarebbe stata la scelta ovvia, ma porta un idioma
visivo — Material Design — pensato per il web e per Android, in
un'applicazione desktop che ha scelto deliberatamente il contrario: il cursore
resta la freccia sui pulsanti, «like a native application», e un test lo
sorveglia.

daisyUI è MIT, è solo CSS, e il vocabolario di controlli di questa applicazione
è minuscolo: 52 pulsanti, 20 campi, 9 select, 1 textarea, **zero tabelle, zero
dialog, zero barre di avanzamento**. Di una libreria da trecento componenti se
ne userebbero otto. daisyUI ne dà esattamente otto — `btn`, `input`, `select`,
`textarea`, `menu`, `drawer`, `tabs`, `badge` — più il `divider` che la colonna
chiede esplicitamente.

**Ciò che daisyUI non dà, e va detto:** comportamento. Niente focus trap,
niente posizionamento di overlay, niente navigazione da tastiera. Il suo
`drawer` si regge su una casella di spunta nascosta, che in Angular si preferisce
sostituire con un signal. Dove il comportamento serve davvero — e in questo
lavoro serve poco — si aggiunge `@angular/cdk`, che è headless e non porta
alcun aspetto con sé. daisyUI veste, il CDK si comporta, e non si contendono
niente.

## Il guscio

`app.html` diventa il guscio e smette di essere un outlet nudo:

```
┌──────────────┬───────────────────────────────┐
│ Progetti   7 │                               │
│ Da approvare 2                               │
│ In corso   1 │        <router-outlet />      │
│ In pausa   0 │                               │
│ Conclusi   4 │                               │
│ ──────────── │                               │
│ IMPOSTAZIONI │                               │
│ Provider     │                               │
│ Glossari     │                               │
│ Traduzione   │                               │
│ Applicazione │                               │
└──────────────┴───────────────────────────────┘
```

Il pannello di destra ospita tutto: la griglia dei progetti, il dettaglio di un
progetto, le impostazioni, «Nuovo progetto». Nessuna schermata prende il
sopravvento sulla finestra.

Le rotte diventano:

| Rotta | Cosa mostra |
|---|---|
| `/projects/:bucket` | La griglia filtrata; `bucket` ∈ `all`, `to-approve`, `running`, `paused`, `done` |
| `/new` | Il modulo di creazione, nel pannello |
| `/project/:id` | Il dettaglio, nel pannello |
| `/settings/:section` | `section` ∈ `providers`, `glossaries`, `translation`, `application` |
| `**` | → `/projects/all` |

«Nuovo progetto» resta l'azione primaria sopra la griglia. Il collegamento alle
impostazioni sparisce dall'intestazione della libreria: è nella colonna, e
averlo in due posti a dieci centimetri di distanza è esattamente il tipo di
disordine che questo lavoro toglie.

Per la stessa ragione **la striscia di tab dentro Impostazioni sparisce**: la
colonna elenca già le quattro sezioni, e ripeterle sarebbe la stessa
navigazione due volte.

### I cinque gruppi

| Voce | Stati |
|---|---|
| Progetti | tutti e undici |
| Da approvare | `waiting-terms`, `waiting-code` |
| In corso | `running`, `composing` |
| In pausa | `paused` |
| Conclusi | `done` |

I gruppi **non partizionano**: `new`, `needs-language`, `ready`, `incomplete` e
`failed` si vedono solo sotto «Progetti», con la loro etichetta di stato sulla
tile. È deliberato. Una voce esiste quando risponde a una domanda che ci si
pone davvero — *cosa aspetta me?*, *cosa sta girando?* — e «Da avviare» non è
una di quelle: un progetto appena creato lo si sta già guardando.

«Da approvare» esiste per la ragione opposta: è l'unica voce che chiede
qualcosa a chi legge, e senza di essa un libro fermo da giorni in attesa di
un'approvazione non ha nessun posto dove farsi trovare.

### I conteggi

Ogni voce porta il proprio numero, da un canale nuovo — `projects.counts` —
che risponde con una sola interrogazione:

```sql
SELECT state, count(*) AS n FROM project GROUP BY state
```

Undici numeri, che il renderer somma nei cinque gruppi. La mappa
stato → gruppo vive quindi in un posto solo, condiviso fra il conteggio e il
filtro.

Il filtro della griglia si applica in SQL. `listProjects(db, filter?: string)`
diventa `listProjects(db, query: { search?: string; bucket?: Bucket })`:
filtrare nel renderer significherebbe trasferire l'intera libreria a ogni clic
e tenere due verità sullo stesso insieme.

## Il ritorno indietro

Non viene corretto. Con il guscio in piedi si esce da «Nuovo progetto»
cliccando una qualunque voce della colonna, e il vicolo cieco smette di poter
esistere invece di essere tappato. L'Annulla dentro il modulo resta — abbandona
esplicitamente il progetto analizzato, con la sua conferma — ma non è più
l'unica uscita, né un'uscita che compare solo a metà del percorso.

## Eliminare, ed esportare

**Eliminare** è un'azione sulla tile: `ui.confirm` con il kind `deleteProject`,
già scritto e già tradotto, poi `project.delete`. Non c'è niente da costruire
dietro; manca il pulsante.

**Esportare** è un'azione a sé, non un ramo dell'eliminazione. Sta nella scheda
Report del dettaglio, accanto all'azione che già apre il libro: è lì che
`outputPath` esiste ed è lì che si va a vedere com'è andata. Apre il
salva-con-nome e copia il libro dove si è scelto. Non si dovrebbe dover
eliminare un progetto per salvarne il risultato, e chi elimina di solito lo fa
*dopo* aver messo via il libro.

Un dettaglio da sistemare: `chooseSave` (`app/main/main.ts:362`) è cablato sui
glossari e filtra `.md`. Deve sapere anche degli EPUB.

Il parametro `keepOutput` di `project.delete` resta dov'è, inutilizzato. Non lo
si toglie: descrive un'operazione corretta, e l'esportazione è la stessa
operazione offerta al momento giusto.

## Il tema

daisyUI sceglie il tema con l'attributo `data-theme` sulla radice; oggi il
processo principale ci mette la classe `.theme-dark`. Cambia il modo, non il
meccanismo: resta `nativeTheme` a decidere, perché su Linux la media query del
renderer si blocca sul valore d'avvio e non sente mai il cambio di sistema
(electron#22211), e resta l'evento `theme.changed` a tenerlo aggiornato a
finestra aperta.

## Cosa si prova

- **I gruppi.** Che ogni stato finisca nel gruppo giusto e che i conteggi
  corrispondano alle righe, su una libreria costruita con tutti e undici gli
  stati. È il test che impedisce a `waiting-code` di sparire dietro un `IN`
  scritto a mano.
- **Il filtro è in SQL.** Che `listProjects` con un gruppo restituisca solo le
  righe di quel gruppo, non l'intera libreria filtrata dopo.
- **Il guscio non se ne va.** Un test di componente che naviga a `/new` e trova
  la colonna ancora nel DOM: è l'asserzione che corrisponde al difetto
  raccontato, e vale più di qualunque controllo sul pulsante Annulla.
- **L'eliminazione chiede prima.** Che la tile chiami `ui.confirm` col kind
  giusto e che un rifiuto lasci il progetto dov'è.
- **L'esportazione non tocca il progetto.** Che copi il file e lasci lo spazio
  di lavoro intatto.
- **Le schermate, in entrambi i temi.** `screens.spec.ts` già cattura le
  ventidue schermate: le sue immagini vanno rigenerate e guardate, perché
  questo lavoro le cambia tutte.

`styles.test.ts` va **riscritto, non ritoccato**. Dei suoi dieci test, quelli
sui componenti — niente esadecimali fuori dal foglio globale, nessun padding
sui campi, una sola regola condivisa per input e select — descrivono una
disciplina che daisyUI rende superflua: non ci sarà quasi più CSS per
componente da sorvegliare. Al loro posto servono asserzioni sulla nuova
fondazione: che il tema si scelga con `data-theme`, che i colori vengano dai
token di daisyUI e non da esadecimali sparsi, e che il cursore resti la freccia
— quella regola sopravvive, perché è una scelta di carattere e non un dettaglio
di implementazione.

## Rischi

**Lo stile si sposta nei template.** Le classi di utilità vivono nell'HTML, non
in un foglio per componente. È un cambio di idioma per l'intero renderer: 1288
righe di template si riscrivono, 475 righe di CSS in gran parte spariscono. Il
guadagno è che l'incoerenza dei controlli diventa impossibile invece che
sorvegliata; il prezzo è che la revisione di questo lavoro è lunga e va fatta
guardando le schermate, non leggendo i diff.

**Tailwind entra nella catena di build.** Serve `.postcssrc.json` con
`@tailwindcss/postcss`, che oggi non esiste: `angular.json` dichiara un solo
foglio globale e nessuna configurazione PostCSS. È il punto in cui il lavoro
può inciampare per ragioni che non c'entrano col disegno.

**Il tema cambia selettore mentre A è in corso.** Il lavoro A non tocca il
renderer, quindi non si scontrano; ma chi esegue questo lavoro deve partire da
un albero dove A è già atterrato, o i due si incontreranno in `app/locales`.

## Come si esegue

Due piani, non uno. Il primo cambia l'aspetto senza cambiare il comportamento;
il secondo aggiunge navigazione e azioni su una fondazione già ferma.

**B1 — la fondazione.** Tailwind e daisyUI nella catena di build, il tema su
`data-theme`, le schermate esistenti portate sui controlli di daisyUI,
`styles.test.ts` riscritto. Nessuna funzione nuova: la prova che sia andato
bene sono le ventidue schermate di `screens.spec.ts`, rigenerate e guardate una
per una. Se qualcosa si comporta diversamente da prima, è un difetto.

**B2 — il guscio e le azioni.** La colonna, i cinque gruppi coi conteggi, le
rotte nuove, la sparizione delle tab dentro Impostazioni, l'eliminazione e
l'esportazione.

Tenerli separati serve a una cosa precisa: se si facesse tutto insieme, una
schermata che dopo il lavoro appare sbagliata potrebbe esserlo per il nuovo
CSS o per la nuova navigazione, e per saperlo bisognerebbe smontare il lavoro.
Diviso in due, la domanda ha sempre una risposta sola.
