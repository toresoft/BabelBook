# babelBook — Piano 8: l'interfaccia

**Stato: in corso** — Task 1–2 completi, al 2026-08-27.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** che l'applicazione smetta di somigliare a un documento HTML senza foglio di stile, e che le tre azioni che distruggono qualcosa chiedano prima.

**Architecture:** un livello di fondamenta in `styles.css` — font di sistema, colori come variabili, tema chiaro e scuro — su cui i fogli di stile dei componenti smettono di ripetere gli stessi valori. Le conferme distruttive passano dal processo main con `dialog.showMessageBox`, che babelBook usa già per l'uscita.

**Piani precedenti:** 1–5 e 7 completi, 6 a sei task su otto.

---

## Cosa ho misurato, guardando

Non è un giudizio di gusto: ho catturato le schermate e letto il codice.

- **Non esiste un `font-family`.** `renderer/src/styles.css` contiene solo il commento dello scaffold di Angular. Il risultato è che **tutta l'applicazione è nel serif di default del browser** — Times. È la ragione principale per cui "sembra brutta": non sembra un programma, sembra una pagina non stilizzata.
- **Non esiste alcun supporto al tema scuro**: nessun `prefers-color-scheme`, nessun `nativeTheme`, nessun `color-scheme`. Su un desktop scuro l'applicazione è un rettangolo bianco.
- **I controlli sono quelli grezzi del browser.** Campi, `select` e pulsanti hanno altezze e bordi diversi fra loro nella stessa riga.
- **L'azione primaria della libreria è un link blu sottolineato** ("Nuovo progetto") accanto a una voce grigia ("Impostazioni"): due elementi di navigazione con la stessa funzione e due aspetti diversi, e quello importante sembra un collegamento ipertestuale.
- **Nella schermata del nuovo progetto "Crea" e "Annulla" sono identici** — e "Annulla" **cancella il progetto**.
- **Il contenuto è ancorato a sinistra** con un tetto di larghezza: in una finestra da 1280 px metà schermo è vuoto, in libreria come nelle unità.
- **Le unità non hanno intestazioni di colonna**: due colonne affiancate e niente che dica quale sia il sorgente e quale la traduzione.
- **I pulsanti di paginazione restano visibili e disattivati** anche quando la pagina è una sola.

## Cosa dicono gli standard

- **Il font di sistema.** Lo stack per un'applicazione desktop è `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", ...`: prende il font dell'ambiente invece di imporne uno.
- **Il cursore.** Le applicazioni native usano la freccia anche sui pulsanti; la manina è per i collegamenti che portano fuori. Un `cursor: pointer` su ogni pulsante è un tic del web.
- **La modalità costa.** Nielsen Norman: una finestra modale *"interrompe il flusso di lavoro"*, aggiunge l'obiettivo di chiuderla e nasconde il contesto. Si giustifica per errori critici, per informazioni senza le quali il sistema non può proseguire, e per suddividere un compito complesso. **Mai** per decisioni complesse che richiedono informazioni esterne.
- **Le azioni distruttive.** GNOME HIG: *"un'azione distruttiva va sempre accompagnata da una conferma o dalla possibilità di annullarla"*, e *"annullare è di solito preferibile, perché evita di interrompere"*. Il pulsante di annullamento va per primo, quello affermativo porta un verbo specifico ("Elimina", non "OK"), e **il Return non si assegna a un'azione irreversibile**.
- **Una dialog non compare mai da sola**: solo come risposta immediata a un gesto deliberato.

### La decisione che questo piano prende

**Non si insegue l'aspetto nativo di nessuna piattaforma.** Un'applicazione Electron che si traveste da macOS su Linux sbaglia dappertutto. Si punta a un aspetto quieto e coerente che **rispetti due cose del sistema**: il suo font e il suo tema. Il resto è nostro, ed è uno solo su tutte le piattaforme.

---

## Dove una dialog serve, e dove no

La domanda che hai posto, con una risposta per caso.

**Sì, e nativa** — sono azioni distruttive, immediate, senza contesto da leggere:

| Dove | Cosa distrugge oggi senza chiedere |
|---|---|
| `new-project` → *Annulla* | **cancella il progetto** e il suo spazio di lavoro |
| Impostazioni → *Elimina* un provider | il provider e la sua chiave cifrata |
| Impostazioni → *Elimina* un glossario | il glossario, e lo stacca dai progetti che lo usano |
| Libreria → eliminare un progetto | l'EPUB tradotto, se non lo si tiene |

Il glossario è il caso peggiore: oggi dice *"staccato da 3 progetti"* **dopo** averlo fatto. È l'informazione giusta al momento sbagliato — deve stare nella domanda, non nel referto.

**No, restano in linea** — sono decisioni lunghe, che si prendono guardando il libro:

- **i due gate**, termini ed esclusioni: leggere quaranta candidati dentro una finestra modale è esattamente ciò che Nielsen Norman sconsiglia;
- **l'anteprima di invalidazione**, che è già un pannello in linea e va bene così: GNOME preferisce i controlli in linea proprio perché non nascondono la finestra sotto;
- **il nuovo progetto**, che mostra una stima e accetta una descrizione: ha bisogno di spazio, e il suo problema non è la mancanza di una dialog ma due pulsanti indistinguibili.

**Native, non HTML.** `dialog.showMessageBox` è già usato per l'uscita: passa dal main, rispetta il tema del sistema, e non è un div che intercetta i tasti.

---

## Global Constraints

- **Nessuna dipendenza grafica nuova.** Un framework di componenti porterebbe più superficie di quanta ne risolva qui.
- **Le fondamenta stanno in un posto solo.** Un colore ripetuto in dodici fogli è un colore che diverge.
- **Nessuna stringa nei componenti**: le dialog parlano dai cataloghi, come tutto il resto.
- **Il tema segue il sistema**, senza un interruttore da manutenere finché nessuno lo chiede.
- **Codice e commenti in inglese**, documenti in italiano.
- **Commit a ogni task.**

---

### Task 1: Le fondamenta

**Files:**
- Modify: `app/renderer/src/styles.css`, `app/main/window.ts`
- Create: `app/test/styles.test.ts`

- [x] **Step 1: I test che falliscono**

Sul foglio globale, perché è l'unico posto dove queste cose possono stare:

- dichiara un `font-family` che comincia con `system-ui`;
- dichiara `color-scheme: light dark`, che è ciò che fa adottare ai controlli nativi il tema giusto;
- definisce i colori come variabili, e ne ridefinisce il valore sotto `prefers-color-scheme: dark`;
- **nessun foglio di componente contiene un colore esadecimale**: un test che scandaglia `renderer/src/**/*.css` e fallisce se ne trova uno fuori da `styles.css`.

L'ultimo è quello che tiene: senza, i colori tornano a spargersi al primo componente nuovo.

- [x] **Step 2: Eseguirli e verificare che falliscano**

- [x] **Step 3: Implementare**

Lo stack di sistema, la scala tipografica, e le variabili di colore in due temi. `window.ts` dichiara `backgroundColor` coerente col tema iniziale, o l'apertura lampeggia di bianco su un desktop scuro.

I fogli dei componenti passano alle variabili. È il grosso del lavoro ed è meccanico.

- [x] **Step 4–5**: eseguire i test, commit.

---

### Task 2: I controlli

**Files:**
- Modify: `app/renderer/src/styles.css`

- [x] **Step 1: I test che falliscono**

- un pulsante primario, uno secondario e uno distruttivo si distinguono da regole diverse, non da un colore scritto a mano nel componente;
- i campi e i `select` condividono altezza e raggio;
- **nessun `cursor: pointer` sui pulsanti**: è la freccia, come in un'applicazione vera.

- [x] **Step 2–5**: come sopra.

Le classi vanno nel foglio globale e i componenti le usano. Tre classi, non un framework.

---

### Task 3: Le conferme che oggi non ci sono

**Files:**
- Modify: `app/main/ipc.ts`, `app/main/main.ts`, `app/shared/channels.ts`, i componenti che eliminano
- Create: `app/test/confirm.test.ts`

**Interfaces:**

```ts
/** Una domanda, e la risposta. Le parole vengono dal catalogo del main. */
"ui.confirm": {
  req: { kind: "deleteProject" | "deleteProvider" | "deleteGlossary" | "abandonProject";
         detail?: Record<string, string | number> };
  res: { confirmed: boolean };
};
```

- [ ] **Step 1: I test che falliscono**

- ogni eliminazione **chiede prima**, e un rifiuto non tocca niente;
- il pulsante affermativo porta un verbo specifico, mai "OK";
- **il Return non è assegnato all'azione distruttiva**, l'Escape annulla;
- la domanda sul glossario **dice quanti progetti perderanno la terminologia**, prima e non dopo;
- le parole arrivano dal catalogo: un test in più fra i quattro che già lo sorvegliano.

- [ ] **Step 2–5**: come sopra.

Il conteggio dei progetti va calcolato **prima** di eliminare, il che significa una lettura in più: è il punto del task.

---

### Task 4: La libreria

**Files:**
- Modify: `app/renderer/src/app/library/*`

- [ ] **Step 1: I test che falliscono**

- "Nuovo progetto" è un pulsante primario, non un collegamento sottolineato;
- la griglia riempie la finestra invece di lasciarne vuota metà;
- la tessera ha una gerarchia leggibile: titolo, lingue e stato, poi l'avanzamento;
- lo stato del progetto si distingue a colpo d'occhio, e non è solo una parola grigia fra le altre.

- [ ] **Step 2–5**: come sopra.

---

### Task 5: Le unità, e il nuovo progetto

**Files:**
- Modify: `app/renderer/src/app/project/units/*`, `app/renderer/src/app/new-project/*`

- [ ] **Step 1: I test che falliscono**

Unità:
- le due colonne hanno **un'intestazione** che dice quale sorgente e quale traduzione;
- la paginazione **non compare** quando la pagina è una sola;
- il conteggio sta accanto al filtro che lo produce.

Nuovo progetto:
- "Crea" è primario, "Annulla" secondario, e **annullare chiede** (Task 3);
- la stima è l'elemento che si legge per primo dopo il titolo, perché è l'informazione su cui si decide.

- [ ] **Step 2–5**: come sopra.

---

### Task 6: Guardare il risultato

**Files:**
- Create: `app/e2e/screens.spec.ts`

- [ ] **Step 1: Il test**

Attraversa le schermate e cattura una immagine per ciascuna, chiaro e scuro. Non confronta pixel — un test che fallisce a ogni spostamento di due pixel viene disattivato entro un mese. Verifica ciò che si può affermare: che nessuna schermata renda testo su fondo dello stesso colore, che il tema scuro cambi davvero il fondo, e che nessun testo esca dal suo contenitore.

- [ ] **Step 2: Guardare le immagini.**

Questo passo non è automatizzabile ed è il motivo del task: **aprire i file e guardarli**. Un piano sull'aspetto che si dichiara finito senza che nessuno abbia guardato è esattamente l'errore che questo piano vuole correggere.

- [ ] **Step 3: Commit**

---

## Definizione di finito

- L'applicazione usa il font del sistema e segue il tema del sistema, chiaro e scuro.
- Nessun colore esadecimale vive fuori dal foglio globale, e un test lo impedisce.
- Le quattro azioni distruttive chiedono prima, con un verbo specifico e senza il Return assegnato.
- La domanda sul glossario dice quanti progetti perderanno la terminologia **prima** di eliminarlo.
- I due gate e l'anteprima di invalidazione **sono rimasti in linea**.
- Le schermate sono state guardate, in entrambi i temi.

## Cosa questo piano non dà

- **Nessun aspetto nativo per piattaforma**: una sola identità su Linux, Windows e macOS.
- **Nessun interruttore del tema**: si segue il sistema. Aggiungerlo è mezz'ora, il giorno che qualcuno lo chieda.
- **Nessuna animazione**, oltre a quelle che esistono già.
- **Nessun framework di componenti**: tre classi in un foglio globale risolvono ciò che qui serve.
- **Nessuna revisione dei testi**: le parole sono un altro mestiere, e i cataloghi sono già in due lingue.
