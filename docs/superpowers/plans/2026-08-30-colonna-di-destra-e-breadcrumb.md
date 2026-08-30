# La colonna di destra e il breadcrumb — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La schermata di un progetto smette di essere un'intestazione seguita da schede e diventa due colonne: a sinistra il lavoro — schede e liste — a destra il libro, il suo stato e la sua corsa, sempre visibili qualunque scheda sia aperta.

**Architecture:** L'intestazione orizzontale e la scheda Panoramica spariscono, e ciò che dicevano si sposta in una colonna laterale che non scorre via con la lista. La colonna è un componente suo (`bb-side`), figlio della schermata del progetto, che riceve il progetto già caricato e non interroga nulla per conto proprio tranne il registro della corsa. Due fatti che oggi il processo main sa ma non dice — il nome del provider e i tempi della corsa — entrano nel DTO; un terzo, lo stato delle cinque fasi, smette di essere dedotto dagli eventi vivi e diventa una funzione pura sul database, così sopravvive a un riavvio.

**Tech Stack:** Node 24.18.0, TypeScript ESM con sola sintassi cancellabile in `core/`, node:sqlite, Electron, Angular 22.1, daisyUI 5, Vitest, Playwright.

**Design:** progetto Claude Design `2840b168-10ef-4f25-b82a-8c737be9ff3d`, file `Project Detail Lists.dc.html` (letto il 2026-08-30). Il mock è la fonte per struttura, gerarchia e contenuto; non per font, raggi e colori — vedi i vincoli.

## Global Constraints

- **Codice e commenti in inglese.** Questo piano è in italiano; il codice no.
- **Ogni stringa esiste in `app/locales/en.json` e in `app/locales/it.json`.** Nessuna frase scritta nel template.
- **Nessun colore fuori da `app/renderer/src/styles.css`.** `app/test/styles.test.ts` fallisce su qualunque `#rrggbb` in un foglio di componente: si usano i token (`--text`, `--surface`, `--line`, `--accent`, `--danger`, `--warning`, `--ok`, `--rest`, `--lift`, e i loro `-soft`/`-line`).
- **Il font resta quello di sistema e i raggi restano 6px.** Il mock usa Inter Tight, IBM Plex Mono e raggi 8–12px: sono decisioni dichiarate in `styles.css` («the two things not ours to choose») e non cambiano in questo piano. Il monospaziato del mock si rende con lo stack `ui-monospace` già in uso.
- **`app/shared/*.ts` non dipende da niente**: i tipi che attraversano l'IPC non importano il processo main.
- **Il guscio non scorre.** `main` è `overflow: hidden` e ogni schermata scorre ciò che deve: la colonna destra scorre per conto suo, la lista per conto suo.
- **La scheda Panoramica sparisce.** Il mock la elenca ancora fra le tab (`tabs: [...]` nello script), ma l'istruzione è esplicita: la colonna destra sostituisce intestazione **e** panoramica. Dove mock e istruzione divergono, vince l'istruzione. Il Report resta.
- Comandi dalla radice del repo. `export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`.
- Test: `npx vitest run <percorso>` per un file, `npm test` per tutto, `npm run test:ui -w app` per i componenti, `npm run typecheck` sempre prima di commettere. Gli screenshot si rigenerano con `npm run test:e2e -w app -- e2e/screens.spec.ts` e **si guardano**.
- **Cinque spec e2e sono rotte da prima di questo piano** (`gates` ×2, `providers` ×1, `translate` ×2, tutte con «the project never reached done»). Non sono in scopo: verificare che restino esattamente cinque, non sei.
- Parte da un albero con il lavoro non commesso delle liste (tabelle, dettaglio, aggiornamento dal vivo, tray). **Commetterlo prima di iniziare**: questo piano lo dà per presente.

## Struttura dei file

| File | Responsabilità |
|---|---|
| `app/renderer/src/app/project/side/side.ts,.html,.css` | **Nuovo.** La colonna destra: identità, metadati, stato e azioni, avvisi, pannello a tab. Riceve `ProjectDetail` in input, emette le azioni verso il genitore. |
| `app/renderer/src/app/project/side/progress-panel.html` | Incluso in `side.html`: la timeline delle cinque fasi. Sta in un file suo perché è la metà del template. |
| `app/main/projects/phases.ts` | **Nuovo.** Funzione pura: dallo stato del progetto e da cosa il database ha registrato, lo stato delle cinque fasi. |
| `app/main/projects/detail.ts` | Aggiunge al DTO il nome di provider e modello, i tempi dell'ultima corsa e le fasi. |
| `app/main/run/events.ts` | **Nuovo.** Legge `run_event` dell'ultima corsa per il registro. |
| `app/shared/dto.ts`, `app/shared/channels.ts` | I tipi nuovi e il canale `run.events`. |
| `app/renderer/src/app/project/project.html,.css,.ts` | Perde l'intestazione e la Panoramica, guadagna il breadcrumb e le due colonne. |

---

### Task 1: Il breadcrumb

Il link «Libreria» isolato in cima diventa un pulsante indietro più una briciola di pane che nomina anche il libro. Piccolo e indipendente: atterra da solo e si vede subito.

**Files:**
- Modify: `app/renderer/src/app/project/project.html` (righe 3–5), `app/renderer/src/app/project/project.css`
- Modify: `app/locales/it.json`, `app/locales/en.json`
- Test: `app/renderer/src/app/project/project.spec.ts`

**Interfaces:**
- Produces: nel DOM, `[data-testid=project-back]` (il pulsante) e `[data-testid=project-crumbs]` (la riga). Il Task 2 li sposta senza rinominarli.

- [ ] **Step 1: Scrivi il test che fallisce**

In coda al `describe("Project")` di `app/renderer/src/app/project/project.spec.ts`:

```ts
  it("names the book in the trail, not only the way back", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    const crumbs = fixture.nativeElement.querySelector("[data-testid=project-crumbs]");
    expect(crumbs.textContent).toContain(it_IT.app.library);
    expect(crumbs.textContent).toContain("A Book");

    // The way back is a button with a name for whoever reads instead of looks.
    const back = fixture.nativeElement.querySelector("[data-testid=project-back]");
    expect(back.getAttribute("aria-label")).toBe(it_IT.project.back);
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

`npx vitest run --root app renderer/src/app/project/project.spec.ts`
Atteso: FAIL, `crumbs` è null.

- [ ] **Step 3: Le stringhe**

In `app/locales/it.json`, dentro `project`: `"back": "Torna alla libreria"`.
In `app/locales/en.json`, dentro `project`: `"back": "Back to the library"`.

- [ ] **Step 4: Il template**

In `app/renderer/src/app/project/project.html` sostituisci `<a class="project__back" routerLink="/">{{ t('app.library') }}</a>` con:

```html
    <nav class="crumbs" data-testid="project-crumbs" aria-label="{{ t('project.back') }}">
      <button type="button" class="btn btn-xs crumbs__back" data-testid="project-back"
              [attr.aria-label]="t('project.back')" [attr.title]="t('project.back')"
              (click)="toLibrary()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 6l-6 6 6 6"></path>
        </svg>
      </button>
      <a routerLink="/">{{ t('app.library') }}</a>
      <span class="crumbs__sep">/</span>
      <span class="crumbs__here" aria-current="page">{{ found.title }}</span>
    </nav>
```

- [ ] **Step 5: Il gesto e lo stile**

In `app/renderer/src/app/project/project.ts`, accanto agli altri metodi (`Router` è già importato? se no: `import { Router } from "@angular/router";` e `#router = inject(Router);`):

```ts
  /** The way back, as a button: the trail beside it is the link. */
  toLibrary(): void {
    void this.#router.navigate(["/"]);
  }
```

In `app/renderer/src/app/project/project.css`, al posto di `.project__back`:

```css
/* Where you are, and the way back from it. */
.crumbs { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--text-muted); }
.crumbs a { color: var(--accent); text-decoration: none; font-weight: 500; }
.crumbs__back { padding-inline: 0.35rem; }
.crumbs__sep { color: var(--line-strong); }
.crumbs__here { color: var(--text); font-weight: 500; overflow-wrap: anywhere; }
```

- [ ] **Step 6: Verifica**

`npx vitest run --root app renderer/src/app/project/project.spec.ts` → PASS.
`npm run test:ui -w app` → tutto verde.
`npm run test:e2e -w app -- e2e/screens.spec.ts` e **guarda** `app/e2e/screenshots/project-overview-light.png`: il pulsante e la briciola stanno sulla stessa riga, allineati al titolo.

- [ ] **Step 7: Commit**

```bash
git add app/renderer/src/app/project app/locales
git commit -m "feat(project): la briciola di pane dice anche dove sei"
```

---

### Task 2: Due colonne, e l'intestazione trasloca

Il guscio della schermata diventa due colonne: a sinistra breadcrumb, tab e lista; a destra la colonna nuova, che in questo task riceve **il markup dell'intestazione così com'è**. Nessun contenuto cambia: cambia dove sta. Deliverable: l'applicazione ha tre colonne e non ha perso niente.

**Files:**
- Create: `app/renderer/src/app/project/side/side.ts`, `side.html`, `side.css`
- Modify: `app/renderer/src/app/project/project.html`, `project.css`
- Test: `app/renderer/src/app/project/side/side.spec.ts` (nuovo)

**Interfaces:**
- Produces: `bb-side` con `readonly project = input.required<ProjectDetail>()` e quattro output `start`, `pause`, `compose`, `remove` (tutti `output<void>()`); nel DOM `[data-testid=side]`. Il genitore lo monta una volta sola, fuori dallo `@switch` delle tab.

- [ ] **Step 1: Scrivi il test che fallisce**

`app/renderer/src/app/project/side/side.spec.ts`:

```ts
import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import type { ProjectDetail } from "../../../../../shared/dto.js";
import { provideI18n } from "../../core/i18n";
import { Side } from "./side";

const detail: ProjectDetail = {
  id: "p1", title: "A Book", author: "An Author", coverPath: null, description: null,
  sourceLanguage: "en", targetLanguage: "it", state: "ready",
  progress: { done: 0, total: 10 }, layout: "reflowable", hasOverlays: false,
  providerId: null, modelId: null, providerName: null, modelName: null,
  actions: ["START"], tokens: { in: 0, out: 0, reasoning: 0 }, cost: null,
  createdAt: "2026-08-24T10:00:00.000Z", outputPath: null,
  runStartedAt: null, runEndedAt: null, finishedAt: null,
  phases: [],
};

function mount(project = detail) {
  TestBed.configureTestingModule({ imports: [Side], providers: [...provideI18n("it")] });
  const fixture = TestBed.createComponent(Side);
  fixture.componentRef.setInput("project", project);
  fixture.detectChanges();
  return { fixture };
}

describe("Side", () => {
  it("says the book it is about", () => {
    const { fixture } = mount();
    const side = fixture.nativeElement.querySelector("[data-testid=side]");
    expect(side.textContent).toContain("A Book");
    expect(side.textContent).toContain("An Author");
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

`npx vitest run --root app renderer/src/app/project/side/side.spec.ts`
Atteso: FAIL, `Cannot find module './side'`.

- [ ] **Step 3: Il componente**

`app/renderer/src/app/project/side/side.ts`:

```ts
import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import { TranslocoDirective } from "@jsverse/transloco";
import type { ProjectDetail } from "../../../../../shared/dto.js";

/**
 * The book, beside the work.
 *
 * What used to be a header above the tabs: it scrolled away with the list and
 * was gone exactly when a long list made it worth having. Here it stays put,
 * whichever tab is open, and it is the only place the state of the run, the
 * money it spent and the reason it stopped are written.
 *
 * It asks nothing of the main process: the project arrives already loaded, and
 * the acts are handed back to the screen that owns them.
 */
@Component({
  selector: "bb-side",
  standalone: true,
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./side.html",
  styleUrl: "./side.css",
})
export class Side {
  readonly project = input.required<ProjectDetail>();

  readonly start = output<void>();
  readonly pause = output<void>();
  readonly compose = output<void>();
  readonly remove = output<void>();

  /** True when the machine would accept this event right now. */
  can(action: string): boolean {
    return this.project().actions.includes(action);
  }
}
```

`side.html` in questo task porta, spostato di peso da `project.html`, il blocco `project__head` (copertina, titolo, autore, lingue, badge di stato) e il blocco `project__actions`, con i `data-testid` invariati (`project-start`, `project-resume`, `project-pause`, `project-compose`, `state-<stato>`) e i `(click)` che diventano `(click)="start.emit()"` e simili. Radice: `<aside class="side" data-testid="side" *transloco="let t"> … </aside>`.

- [ ] **Step 4: Il guscio a due colonne**

In `project.html`: il breadcrumb, la nav delle tab e `.project__panel` restano dentro un nuovo `<div class="project__main">`; `<bb-side [project]="found" (start)="start()" (pause)="pause()" (compose)="compose()" (remove)="remove()" />` è il fratello che segue. Il blocco `project__head` e `project__run` spariscono da qui.

In `project.ts`: `imports: [..., Side]`, e un metodo `remove()` che ripete quello della libreria (`ui.confirm` con `kind: "deleteProject"`, poi `project.delete`, poi `this.#router.navigate(["/"])`).

In `project.css`:

```css
/* Two columns: the work, and the book it is about. The right one is fixed in
   character and elastic in width; below 60rem the window is too narrow for
   two and it goes under the list rather than squeezing it. */
.project {
  padding: 0; max-width: none; height: 100%; box-sizing: border-box;
  display: flex; flex-direction: row; gap: 0; align-items: stretch;
}
.project__main {
  flex: 3 1 35rem; min-width: 24.75rem; display: flex; flex-direction: column;
  gap: 0.75rem; padding: 1.5rem; box-sizing: border-box; min-height: 0;
}
@media (max-width: 60rem) {
  .project { flex-direction: column; overflow-y: auto; }
  .project__main { flex: none; }
}
```

E in `side.css` la colonna:

```css
.side {
  flex: 1 1 20rem; min-width: 16.5rem; max-width: 28.75rem;
  border-left: 1px solid var(--line); background: var(--surface-raised);
  display: flex; flex-direction: column; overflow-y: auto; overflow-x: hidden;
}
```

- [ ] **Step 5: Verifica**

`npx vitest run --root app renderer/src/app/project/side/side.spec.ts` → PASS.
`npm run test:ui -w app` e `npm test` → verdi (il `project.spec.ts` esistente che cerca `project-start` continua a trovarlo: è nel DOM, dentro `bb-side`).
`npm run test:e2e -w app -- e2e/screens.spec.ts e2e/create-project.spec.ts` e **guarda i cinque screenshot del progetto in entrambi i temi**: la colonna destra c'è, la lista non si è ristretta sotto i 396px, `gates.spec` non è fra i verdi ma non deve peggiorare.

- [ ] **Step 6: Commit**

```bash
git add app/renderer/src/app/project
git commit -m "feat(project): il libro sta accanto al lavoro, non sopra"
```

---

### Task 3: Identità, metadati e la descrizione che si legge

La colonna prende la forma del disegno: copertina con ombra, titolo su tre righe, autore, i chip che dicono che EPUB è; poi Lingue, Provider e Descrizione — quest'ultima un pulsante che apre una modale, o «assente» in corsivo.

**Files:**
- Modify: `app/shared/dto.ts`, `app/main/projects/detail.ts`
- Modify: `app/renderer/src/app/project/side/side.ts,.html,.css`
- Modify: `app/locales/it.json`, `app/locales/en.json`
- Test: `app/test/project-detail.test.ts`, `app/renderer/src/app/project/side/side.spec.ts`

**Interfaces:**
- Produces: in `ProjectDetail`, `providerName: string | null` e `modelName: string | null`. Nel DOM: `[data-testid=side-description]` (il pulsante «Leggi»), `[data-testid=description-modal]`.

- [ ] **Step 1: Scrivi il test del processo main che fallisce**

In `app/test/project-detail.test.ts`:

```ts
  it("names the provider and the model, not their identifiers", () => {
    const db = seeded();
    db.prepare("INSERT INTO provider (id, name, route) VALUES ('pr1', 'Anthropic', 'anthropic')").run();
    db.prepare(`
      INSERT INTO provider_model (id, provider_id, model_id, display_name)
      VALUES ('m1', 'pr1', 'claude-opus-5', 'Claude Opus 5')
    `).run();
    db.prepare("UPDATE project SET provider_id = 'pr1', model_id = 'claude-opus-5' WHERE id = 'p1'").run();

    const found = projectDetail(db, "p1")!;
    expect(found.providerName).toBe("Anthropic");
    expect(found.modelName).toBe("Claude Opus 5");
  });

  it("falls back to the model's own id when the catalogue never named it", () => {
    const db = seeded();
    db.prepare("INSERT INTO provider (id, name, route) VALUES ('pr1', 'Anthropic', 'anthropic')").run();
    db.prepare("UPDATE project SET provider_id = 'pr1', model_id = 'claude-opus-5' WHERE id = 'p1'").run();

    expect(projectDetail(db, "p1")!.modelName).toBe("claude-opus-5");
  });
```

- [ ] **Step 2: Esegui e verifica che fallisca**

`npx vitest run app/test/project-detail.test.ts` → FAIL, `providerName` non esiste.

- [ ] **Step 3: La query e il tipo**

In `app/shared/dto.ts`, dentro `ProjectDetail`, dopo `modelId`:

```ts
  /** The provider's and the model's names, as a reader knows them. */
  providerName: string | null;
  modelName: string | null;
```

In `app/main/projects/detail.ts`, nella SELECT, dopo `output_path`:

```sql
           (SELECT pr.name FROM provider pr WHERE pr.id = p.provider_id) AS provider_name,
           -- The catalogue's display name when it has one, the model's own id
           -- when it has not: an id is worse than a name and better than blank.
           coalesce(
             (SELECT pm.display_name FROM provider_model pm
               WHERE pm.provider_id = p.provider_id AND pm.model_id = p.model_id),
             p.model_id
           ) AS model_name
```

In `DetailRow`: `provider_name: string | null; model_name: string | null;`.
Nel `return`: `providerName: row.provider_name, modelName: row.model_name,`.

- [ ] **Step 4: Le stringhe**

In `it.json` dentro `project`: `"languages": "Lingue"`, `"provider": "Provider"`, `"description": "Descrizione"`, `"readDescription": "Leggi"`, `"noDescriptionShort": "assente"`, `"descriptionTitle": "Descrizione del libro"`, `"noProvider": "nessuno"`.
In `en.json`: `"Languages"`, `"Provider"`, `"Description"`, `"Read"`, `"none"`, `"The book's description"`, `"none"`.

I chip sono **due**, e solo due: `layout.reflowable` / `layout.pre-paginated`, che l'applicazione sa,
e una stringa nuova `overlays.present` («Lettura sincronizzata» / «Synchronised reading»),
mostrata solo quando `hasOverlays` è vero — che l'applicazione sa anche quella, e che è la sola
cosa dell'EPUB per cui vale un avviso. Il terzo chip del mock, «Senza DRM», **non si fa**: nessuna
riga di questo programma guarda `META-INF/encryption.xml`, e un chip che dichiara ciò che nessuno
ha controllato è una bugia con un bordo arrotondato. Il mock è un esempio, non un contratto.

- [ ] **Step 5: Il template**

In `side.html`, in cima all'aside: la copertina (`<img class="side__cover">` quando `coverPath`, altrimenti un riquadro con `library.noCover`), il titolo con `[attr.title]` e clamp a tre righe, l'autore, e la fila di chip. Sotto, separati da `<div class="side__rule"></div>`, tre righe etichetta/valore per lingue, provider (`providerName` + ` · ` + `modelName`, o `project.noProvider`) e descrizione. Il pulsante «Leggi» apre `bb-detail` — il dialogo condiviso che già esiste in `app/renderer/src/app/project/detail.ts` — con `[title]="t('project.descriptionTitle')"` e la descrizione nel corpo.

- [ ] **Step 6: Il test del componente**

```ts
  it("offers the description to read, and says when there is none", () => {
    const { fixture } = mount({ ...detail, description: "Un manuale di Angular." });
    fixture.nativeElement.querySelector("[data-testid=side-description]").click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=detail]").textContent)
      .toContain("Un manuale di Angular.");

    const { fixture: without } = mount();
    expect(without.nativeElement.querySelector("[data-testid=side-description]")).toBeNull();
  });
```

- [ ] **Step 7: Verifica e commit**

`npm run typecheck`, `npm test`, `npm run test:ui -w app`. Rigenera gli screenshot e **guarda** la colonna nei due temi: la copertina non è tagliata, il titolo lungo si ferma a tre righe.

```bash
git add app/shared app/main/projects app/renderer/src/app/project app/locales app/test
git commit -m "feat(project): la colonna dice di che libro si tratta"
```

---

### Task 4: Lo stato, l'azione e i numeri della corsa

Il badge con l'icona, l'azione primaria contestuale che occupa la larghezza, l'eliminazione a icona, e sotto la riga tratteggiata i cinque numeri: creazione, esecuzione, conclusione, token, costo.

**Files:**
- Modify: `app/shared/dto.ts`, `app/main/projects/detail.ts`
- Modify: `app/renderer/src/app/project/side/side.ts,.html,.css`, `app/locales/*.json`
- Test: `app/test/project-detail.test.ts`, `app/renderer/src/app/project/side/side.spec.ts`

**Interfaces:**
- Produces: in `ProjectDetail`, `runStartedAt: string | null` e `runEndedAt: string | null` (l'ultima corsa). Nel DOM: `[data-testid=side-action]`, `[data-testid=side-delete]`, `[data-testid=side-meta]`.

- [ ] **Step 1: Il test del processo main**

```ts
  it("carries the last run's clock, so the column can say how long it took", () => {
    const db = seeded();
    db.prepare(`
      INSERT INTO run (id, project_id, phase, started_at, ended_at)
      VALUES ('r1', 'p1', 'translate', '2026-08-30T09:12:00.000Z', '2026-08-30T09:45:12.000Z'),
             ('r2', 'p1', 'translate', '2026-08-30T10:00:00.000Z', NULL)
    `).run();

    const found = projectDetail(db, "p1")!;
    // The last one: a project's clock is the run it is in, not the one before.
    expect(found.runStartedAt).toBe("2026-08-30T10:00:00.000Z");
    expect(found.runEndedAt).toBeNull();
  });
```

- [ ] **Step 2: Esegui, verifica il fallimento, poi la query**

Nella SELECT di `detail.ts`:

```sql
           (SELECT r.started_at FROM run r WHERE r.project_id = p.id
             ORDER BY r.started_at DESC LIMIT 1) AS run_started_at,
           (SELECT r.ended_at FROM run r WHERE r.project_id = p.id
             ORDER BY r.started_at DESC LIMIT 1) AS run_ended_at
```

- [ ] **Step 3: L'azione contestuale**

In `side.ts`, una sola azione primaria decisa dalla macchina, non dal nome dello stato:

```ts
  /** The one act the column offers, and the event it sends. */
  primary(): { label: string; event: "START" | "PAUSE" | "COMPOSE" } | null {
    if (this.can("PAUSE")) return { label: "library.pause", event: "PAUSE" };
    if (this.can("RESUME")) return { label: "library.resume", event: "START" };
    if (this.can("START")) return { label: "library.translate", event: "START" };
    if (this.can("COMPOSE")) return { label: "library.compose", event: "COMPOSE" };
    return null;
  }
```

Quando il progetto è concluso e ha un `outputPath`, l'azione primaria è «Scarica EPUB» e apre il file con `file.open` (lo stesso canale della libreria); il pulsante ha `data-testid="side-download"`.

- [ ] **Step 4: I numeri**

Cinque righe etichetta/valore, con le stringhe nuove `project.createdOn`, `project.elapsed`, `project.endedOn` (in italiano: «Creato il», «Esecuzione», «Concluso il») e le due che esistono già (`project.cost`, `report.tokens`). La durata si calcola in `side.ts`:

```ts
  /** How long the last run has been going, or went. */
  elapsed(): string | null {
    const started = this.project().runStartedAt;
    if (started === null) return null;
    const end = this.project().runEndedAt ?? new Date().toISOString();
    const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(started)) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
```

- [ ] **Step 5: Il test del componente**

```ts
  it("offers one act, the one the machine would accept", () => {
    const { fixture } = mount({ ...detail, actions: ["PAUSE"] });
    expect(fixture.nativeElement.querySelector("[data-testid=side-action]").textContent)
      .toContain(it_IT.library.pause);
  });

  it("keeps deleting quiet, and asks before doing it", () => {
    const { fixture } = mount();
    const remove = fixture.nativeElement.querySelector("[data-testid=side-delete]");
    expect(remove.className).not.toContain("btn-error");
    expect(remove.getAttribute("aria-label")).toBe(it_IT.library.delete);
  });
```

- [ ] **Step 6: Verifica e commit**

```bash
git add app/shared app/main/projects app/renderer/src/app/project app/locales app/test
git commit -m "feat(project): lo stato, l'atto e il conto stanno nella colonna"
```

---

### Task 5: Gli stati diventano oggetti con una data e una storia

Oggi `project.state` è una parola su una riga: dice cos'è un libro adesso e niente su come ci è arrivato. La colonna destra chiede quattro cose che quella parola non sa — quando è cominciata l'analisi, quanto è durata l'estrazione, perché la terza fase si è fermata, quando il libro è finito — e finora ognuna si sarebbe dedotta dalla presenza di una riga di risultato o dall'orologio dell'intera corsa. Questo task le fa **registrare**.

È il task che regge i tre che lo seguono: la timeline, il registro e i numeri smettono di essere deduzioni.

**Files:**
- Create: `app/main/db/migrations/014-project-state.sql`
- Create: `app/main/run/states.ts`, `app/test/states.test.ts`
- Modify: `app/main/projects/create.ts`, `app/main/run/runtime.ts`
- Modify: `app/test/migrate.test.ts` (l'elenco delle migrazioni applicate)

**Interfaces:**
- Produces, in `app/main/run/states.ts`:

```ts
export interface StateRecord {
  kind: "project" | "phase";
  name: string;
  outcome: "done" | "failed" | "paused" | "cancelled" | null;
  enteredAt: string;
  leftAt: string | null;
  info: Record<string, unknown> | null;
}

export function enterState(db: DatabaseSync, entry: {
  projectId: string; runId?: string | null; kind: StateRecord["kind"];
  name: string; info?: Record<string, unknown>;
}): void;

export function leaveState(db: DatabaseSync, entry: {
  projectId: string; kind: StateRecord["kind"];
  outcome: NonNullable<StateRecord["outcome"]>; info?: Record<string, unknown>;
}): void;

export function statesOf(db: DatabaseSync, projectId: string): StateRecord[];
```

- [ ] **Step 1: Scrivi il test che fallisce**

`app/test/states.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { enterState, leaveState, statesOf } from "../main/run/states.ts";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                         target_language, state, layout)
    VALUES ('p1','b.epub','Book','/w','sha','2026-08-30T09:00:00.000Z','it','ready','reflowable')
  `).run();
  return db;
}

describe("the states of a project", () => {
  it("remembers what it entered, and when", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "phase", name: "analyze", info: { units: 9701 } });

    const [entry] = statesOf(db, "p1").filter((s) => s.kind === "phase");
    expect(entry).toMatchObject({ name: "analyze", outcome: null, leftAt: null });
    expect(entry!.info).toEqual({ units: 9701 });
    expect(Date.parse(entry!.enteredAt)).not.toBeNaN();
  });

  it("closes what it leaves, and says how it ended", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "phase", name: "analyze" });
    leaveState(db, { projectId: "p1", kind: "phase", outcome: "done", info: { seconds: 108 } });

    const [entry] = statesOf(db, "p1").filter((s) => s.kind === "phase");
    expect(entry).toMatchObject({ outcome: "done" });
    expect(entry!.leftAt).not.toBeNull();
    // What it learned on the way out joins what it knew on the way in.
    expect(entry!.info).toEqual({ seconds: 108 });
  });

  /*
   * Two phases open at once would make "which phase is the book in?" a
   * question with two answers, and the timeline would draw both as running.
   */
  it("closes the one before when a new one of the same kind is entered", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "phase", name: "analyze" });
    enterState(db, { projectId: "p1", kind: "phase", name: "candidates" });

    const phases = statesOf(db, "p1").filter((s) => s.kind === "phase");
    expect(phases.map((p) => [p.name, p.leftAt === null]))
      .toEqual([["analyze", false], ["candidates", true]]);
  });

  it("keeps the project's own states apart from its phases", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "phase", name: "translate" });
    enterState(db, { projectId: "p1", kind: "project", name: "running" });

    // Entering a project state must not close a phase, and the other way round.
    expect(statesOf(db, "p1").filter((s) => s.leftAt === null)).toHaveLength(2);
  });

  it("gives them back oldest first: a history is read forwards", () => {
    const db = seeded();
    enterState(db, { projectId: "p1", kind: "project", name: "running" });
    enterState(db, { projectId: "p1", kind: "project", name: "waiting-terms" });

    expect(statesOf(db, "p1").map((s) => s.name)).toEqual(["running", "waiting-terms"]);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

`npx vitest run app/test/states.test.ts`
Atteso: FAIL, `Cannot find module '../main/run/states.ts'`.

- [ ] **Step 3: La migrazione**

`app/main/db/migrations/014-project-state.sql`:

```sql
-- A state is something that happened, not a word on a row.
--
-- `project.state` says what a book is now and nothing about how it got there:
-- when the analysis began, how long the extraction took, why the third phase
-- stopped, when the book was finished. Every one of those was about to be
-- guessed — from the presence of a result row, or from the clock of the whole
-- run — and a guess that looks like a fact is the worst kind of interface.
--
-- So every state a project enters, its own and the phases of its runs, is
-- appended here with its own dates and its own information. `project.state`
-- stays where it is: this table explains it, it does not replace it.
CREATE TABLE project_state (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  run_id     TEXT REFERENCES run (id) ON DELETE SET NULL,
  -- Two kinds in one table because they are read as one history: the log
  -- interleaves "run started" with "phase 2 finished", and a join of two
  -- tables to tell one story is two tables too many.
  kind       TEXT NOT NULL CHECK (kind IN ('project', 'phase')),
  name       TEXT NOT NULL,
  outcome    TEXT CHECK (outcome IN ('done', 'failed', 'paused', 'cancelled')),
  entered_at TEXT NOT NULL,
  left_at    TEXT,
  info_json  TEXT
);

CREATE INDEX project_state_project ON project_state (project_id, entered_at);

-- What the books already in the library can still say for themselves: when
-- they were created, and what they are now. An old book with a short history
-- is honest; one with an invented history is not.
INSERT INTO project_state (id, project_id, run_id, kind, name, outcome, entered_at, left_at, info_json)
  SELECT lower(hex(randomblob(16))), p.id, NULL, 'project', p.state, NULL, p.created_at, NULL, NULL
    FROM project p;
```

In `app/test/migrate.test.ts`, il test DeepSeek elenca le migrazioni applicate: aggiungi `"014-project-state"` in coda all'array atteso.

- [ ] **Step 4: Il modulo**

`app/main/run/states.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** One state a project entered, with the dates and the facts that are its own. */
export interface StateRecord {
  kind: "project" | "phase";
  name: string;
  outcome: "done" | "failed" | "paused" | "cancelled" | null;
  enteredAt: string;
  leftAt: string | null;
  info: Record<string, unknown> | null;
}

interface Row {
  kind: string; name: string; outcome: string | null;
  entered_at: string; left_at: string | null; info_json: string | null;
}

const now = (): string => new Date().toISOString();

/**
 * Enters a state, closing whatever of the same kind was open.
 *
 * Two open phases would make "which phase is this book in?" a question with
 * two answers, and a timeline that draws both as running. Closing here rather
 * than asking every caller to remember is what keeps that impossible.
 */
export function enterState(db: DatabaseSync, entry: {
  projectId: string; runId?: string | null; kind: StateRecord["kind"];
  name: string; info?: Record<string, unknown>;
}): void {
  db.prepare(`
    UPDATE project_state SET left_at = ?
     WHERE project_id = ? AND kind = ? AND left_at IS NULL
  `).run(now(), entry.projectId, entry.kind);

  db.prepare(`
    INSERT INTO project_state (id, project_id, run_id, kind, name, entered_at, info_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), entry.projectId, entry.runId ?? null, entry.kind, entry.name, now(),
    entry.info === undefined ? null : JSON.stringify(entry.info),
  );
}

/** Closes the open state of a kind, saying how it ended and what it learned. */
export function leaveState(db: DatabaseSync, entry: {
  projectId: string; kind: StateRecord["kind"];
  outcome: NonNullable<StateRecord["outcome"]>; info?: Record<string, unknown>;
}): void {
  db.prepare(`
    UPDATE project_state
       SET left_at = ?, outcome = ?, info_json = coalesce(?, info_json)
     WHERE project_id = ? AND kind = ? AND left_at IS NULL
  `).run(
    now(), entry.outcome,
    entry.info === undefined ? null : JSON.stringify(entry.info),
    entry.projectId, entry.kind,
  );
}

/** The whole history, oldest first: a history is read forwards. */
export function statesOf(db: DatabaseSync, projectId: string): StateRecord[] {
  const rows = db.prepare(`
    SELECT kind, name, outcome, entered_at, left_at, info_json
      FROM project_state WHERE project_id = ?
     ORDER BY entered_at ASC, rowid ASC
  `).all(projectId) as unknown as Row[];

  return rows.map((row) => ({
    kind: row.kind as StateRecord["kind"],
    name: row.name,
    outcome: row.outcome as StateRecord["outcome"],
    enteredAt: row.entered_at,
    leftAt: row.left_at,
    // A payload that stopped being JSON is a fact we no longer have, not a
    // crash: the history is read on a screen, and one bad row must not empty it.
    info: parse(row.info_json),
  }));
}

function parse(payload: string | null): Record<string, unknown> | null {
  if (payload === null) return null;
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Esegui il test e verifica che passi**

`npx vitest run app/test/states.test.ts` → cinque test verdi.

- [ ] **Step 6: Chi scrive**

**Alla creazione** (`app/main/projects/create.ts`, dentro la transazione che inserisce il progetto, dopo le unità):

```ts
      // The analysis is a phase like the others; it just happens before any
      // run exists, and the units are what it produced.
      enterState(db, { projectId, kind: "phase", name: "analyze" });
      leaveState(db, {
        projectId, kind: "phase", outcome: "done",
        info: { documents: documents.length, units: allUnits.length, skipped },
      });
      enterState(db, {
        projectId, kind: "project",
        name: sourceLanguage === null ? "needs-language" : "ready",
      });
```

**Nel runtime** (`app/main/run/runtime.ts`):
- dove oggi trasmette `run.phase` (riga ~193): `enterState(db, { projectId: activeId, runId: activeRunId, kind: "phase", name: message.phase });`
- nel ramo `done` (riga ~220): `leaveState(db, { projectId: activeId, kind: "phase", outcome: "done", info: { units: message.summary.units } });`
- nel ramo `failed`: `leaveState(db, { projectId: activeId, kind: "phase", outcome: "failed", info: { code: message.code } });`
- in `pause()`: `leaveState(db, { projectId, kind: "phase", outcome: "paused" });`
- nella funzione `changed(projectId)`, che è già il punto unico da cui passa ogni cambio di stato: prima della trasmissione,

```ts
  const changed = (projectId: string): void => {
    const state = db.prepare("SELECT state FROM project WHERE id = ?").get(projectId) as
      { state: string } | undefined;
    if (state !== undefined) {
      enterState(db, { projectId, runId: activeRunId, kind: "project", name: state.state });
    }
    deps.broadcast("project.changed", { id: projectId });
  };
```

- [ ] **Step 7: Il test che dimostra la scrittura**

In `app/test/orchestrator.test.ts` o `app/test/lifecycle.test.ts` non c'è un runtime vero; il posto giusto è `app/test/run-runtime.test.ts` se esiste, altrimenti l'e2e. La prova minima e onesta, in `app/test/create.test.ts`:

```ts
  it("writes the analysis down as a phase that happened, with what it found", () => {
    // ... crea un progetto con due documenti ...
    const phases = statesOf(db, created.id).filter((s) => s.kind === "phase");
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ name: "analyze", outcome: "done" });
    expect(phases[0]!.info).toMatchObject({ documents: 2 });
    expect(phases[0]!.leftAt).not.toBeNull();
  });
```

- [ ] **Step 8: Verifica e commit**

`npm test`, `npm run typecheck`. Poi **una prova nella finestra vera**: apri un libro, fai partire una corsa con il backend finto, e interroga il database del profilo di prova —

```bash
sqlite3 "$DIR/babelbook.db" "SELECT kind, name, outcome, entered_at, left_at FROM project_state ORDER BY entered_at"
```
Attese: una riga `phase/analyze/done` con due date, una riga per ogni fase attraversata, e le righe `project` che raccontano ready → running → … Se una fase resta aperta dopo la fine della corsa, il ramo `done` non sta chiudendo: si corregge qui, non nella colonna.

```bash
git add app/main/db/migrations app/main/run/states.ts app/main/projects/create.ts app/main/run/runtime.ts app/test
git commit -m "feat(run): uno stato è una cosa che è successa, con la sua data e le sue informazioni"
```

---

### Task 6: Le cinque fasi, lette dalla loro storia

Il pannello «Avanzamento»: una riga per fase, con pallino, connettore, barra e nota. Ogni riga legge il record della propria fase — quando è cominciata, quando è finita, com'è finita, cosa ha prodotto — invece di dedurlo.

**Files:**
- Create: `app/main/projects/phases.ts`, `app/test/phases.test.ts`
- Create: `app/renderer/src/app/project/side/progress-panel.html`
- Modify: `app/shared/dto.ts`, `app/main/projects/detail.ts`, `side.ts`, `side.html`, `side.css`, `app/locales/*.json`

**Interfaces:**
- Produces:

```ts
// app/shared/dto.ts
export type PhaseState = "done" | "running" | "waiting" | "failed" | "paused";

export interface PhaseProgress {
  phase: RunPhase;
  state: PhaseState;
  /** When it began and when it ended, from the state it recorded. */
  startedAt: string | null;
  endedAt: string | null;
  /** Only the translation counts the book; the others count their own work. */
  done: number | null;
  total: number | null;
  /** What that phase knows about itself: counts, an error code, a path. */
  info: Record<string, unknown> | null;
}
```
e in `ProjectDetail`: `phases: PhaseProgress[]` (sempre cinque, nell'ordine di `RUN_PHASES`) e `finishedAt: string | null` (la data in cui il progetto è entrato in `done`, dal registro degli stati — non l'orologio della corsa).

- [ ] **Step 1: Scrivi il test che fallisce**

`app/test/phases.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { phasesOf } from "../main/projects/phases.ts";
import type { StateRecord } from "../main/run/states.ts";

const phase = (name: string, outcome: StateRecord["outcome"], left: string | null): StateRecord => ({
  kind: "phase", name, outcome, enteredAt: "2026-08-30T09:00:00.000Z", leftAt: left, info: null,
});

const units = { done: 3, total: 10 };

describe("phasesOf", () => {
  it("says five, always, in the order the run walks them", () => {
    expect(phasesOf([], "ready", units).map((p) => p.phase))
      .toEqual(["analyze", "candidates", "code-index", "translate", "compose"]);
  });

  it("a phase nobody has entered is waiting, and has no dates to show", () => {
    const [analyze, candidates] = phasesOf([], "ready", units);
    expect(analyze).toMatchObject({ state: "waiting", startedAt: null, endedAt: null });
    expect(candidates!.state).toBe("waiting");
  });

  it("reads what happened from the record, not from the project's state", () => {
    const history = [
      phase("analyze", "done", "2026-08-30T09:02:00.000Z"),
      phase("candidates", null, null),
    ];
    const [analyze, candidates] = phasesOf(history, "running", units);
    expect(analyze).toMatchObject({ state: "done", endedAt: "2026-08-30T09:02:00.000Z" });
    expect(candidates!.state).toBe("running");
  });

  /*
   * A phase left open by a run that died is not a phase that is running: the
   * project's state is the only thing that knows the difference.
   */
  it("does not call an open phase running when nothing is running", () => {
    const history = [phase("analyze", "done", "x"), phase("translate", null, null)];
    expect(phasesOf(history, "paused", units)[3]!.state).toBe("paused");
    expect(phasesOf(history, "failed", units)[3]!.state).toBe("failed");
  });

  it("carries the phase's own information through", () => {
    const history = [{ ...phase("analyze", "done", "x"), info: { documents: 412 } }];
    expect(phasesOf(history, "ready", units)[0]!.info).toEqual({ documents: 412 });
  });

  it("counts the book on the translation, and nothing on the rest", () => {
    const history = [phase("translate", null, null)];
    const phases = phasesOf(history, "running", units);
    expect(phases[3]).toMatchObject({ done: 3, total: 10 });
    expect(phases[0]!.total).toBeNull();
  });

  it("keeps the last word when a phase ran twice", () => {
    const history = [
      { ...phase("translate", "paused", "2026-08-30T09:10:00.000Z"), info: { attempt: 1 } },
      { ...phase("translate", "done", "2026-08-30T10:00:00.000Z"), info: { attempt: 2 } },
    ];
    expect(phasesOf(history, "done", units)[3]).toMatchObject({
      state: "done", endedAt: "2026-08-30T10:00:00.000Z", info: { attempt: 2 },
    });
  });
});
```

- [ ] **Step 2: Esegui e verifica che fallisca**

`npx vitest run app/test/phases.test.ts` → FAIL, modulo assente.

- [ ] **Step 3: La funzione**

`app/main/projects/phases.ts`:

```ts
import { RUN_PHASES, type PhaseProgress, type PhaseState, type RunPhase } from "../../shared/dto.ts";
import type { StateRecord } from "../run/states.ts";

/** The project states in which a phase left open is a phase actually moving. */
const MOVING = new Set(["running", "composing", "waiting-terms", "waiting-code"]);

/**
 * The five phases, each read from the last state it recorded.
 *
 * The record says when a phase began, when it ended and how; the project's
 * state says whether a phase still open is moving or was abandoned there by a
 * pause, a failure or a window that closed. Neither answers alone.
 */
export function phasesOf(
  history: StateRecord[],
  projectState: string,
  units: { done: number; total: number },
): PhaseProgress[] {
  const last = new Map<string, StateRecord>();
  for (const entry of history) {
    if (entry.kind === "phase") last.set(entry.name, entry);
  }

  return RUN_PHASES.map((phase) => {
    const entry = last.get(phase);
    const counts = phase === "translate" ? units : { done: null, total: null };
    if (entry === undefined) {
      return {
        phase, state: "waiting" as PhaseState, startedAt: null, endedAt: null,
        done: counts.done, total: counts.total, info: null,
      };
    }
    return {
      phase,
      state: stateOf(entry, projectState),
      startedAt: entry.enteredAt,
      endedAt: entry.leftAt,
      done: counts.done,
      total: counts.total,
      info: entry.info,
    };
  });
}

function stateOf(entry: StateRecord, projectState: string): PhaseState {
  if (entry.outcome === "done") return "done";
  if (entry.outcome === "failed") return "failed";
  if (entry.outcome === "paused") return "paused";
  if (entry.leftAt !== null) return "waiting";
  if (projectState === "failed") return "failed";
  if (projectState === "paused") return "paused";
  return MOVING.has(projectState) ? "running" : "waiting";
}
```

- [ ] **Step 4: Collegala al DTO**

In `app/main/projects/detail.ts`, dopo la query:

```ts
  const history = statesOf(db, projectId);
  const phases = phasesOf(history, row.state, {
    done: Number(row.done), total: Number(row.total),
  });
  // When the book was finished, from the state that says so.
  const finishedAt = history
    .filter((entry) => entry.kind === "project" && entry.name === "done")
    .at(-1)?.enteredAt ?? null;
```
e `phases, finishedAt,` nel `return`. Il campo `runEndedAt` del Task 4 resta per «Esecuzione»; `finishedAt` è «Concluso il», e i due non sono la stessa cosa: una corsa può finire senza che il libro sia finito.

- [ ] **Step 5: Il pannello**

`progress-panel.html`, incluso da `side.html`: per ogni fase una riga a due colonne — il pallino (bordo e riempimento secondo lo stato, spunta per `done`, X per `failed`, due sbarrette per `paused`, `loading loading-spinner loading-xs` per `running`) con il connettore verticale sotto; a destra il nome (`t('phase.' + p.phase)`, che esiste già con esattamente le cinque etichette del mock) e a destra la meta:

- `done` → la durata, calcolata da `startedAt`/`endedAt` con lo stesso `elapsed()` del Task 4, estratto in una funzione condivisa `between(from, to)`;
- `running` → `{{ p.done }} / {{ p.total }}` per la traduzione, `t('phase.running')` per le altre;
- `paused` → `t('state.paused')`, `failed` → `t('phase.failed')`, `waiting` → `t('phase.waiting')`.

La barra si mostra solo per la fase in corso: `<progress class="progress progress-primary" [value]="p.done" [max]="p.total">` quando ci sono numeri, e **senza `value`** quando non ce ne sono — daisyUI anima da sola l'indeterminata (`.progress:indeterminate`), quindi nessuna keyframe nuova. La nota sotto la barra compare solo per `failed`, e dice il codice: `t('errors.' + p.info?.['code'])` con ripiego sul codice grezzo.

Stringhe nuove: `phase.running` («in corso»), `phase.waiting` («in attesa»), `phase.failed` («errore»), `phase.doneIn` («fatto in {{duration}}»).

`prefers-reduced-motion` non è rispettato da daisyUI: in `side.css`

```css
@media (prefers-reduced-motion: reduce) {
  .side .loading, .side .progress:indeterminate { animation: none; }
}
```

- [ ] **Step 6: Le due schede del pannello**

`side.ts` guadagna `readonly panel = signal<"progress" | "log">("progress")` e due pulsanti (`[data-testid=side-tab-progress]`, `[data-testid=side-tab-log]`). Il Log è vuoto fino al Task 7.

- [ ] **Step 7: Verifica e commit**

`npx vitest run app/test/phases.test.ts` → sette verdi. `npm test`, `npm run test:ui -w app`. Poi **guarda**: una corsa vera col backend finto, e la timeline mentre passa da una fase all'altra.

```bash
git add app/main/projects app/shared app/renderer/src/app/project app/test app/locales
git commit -m "feat(project): la timeline legge la storia delle fasi, non la indovina"
```

---

### Task 7: Il registro della corsa

La seconda scheda del pannello: la storia degli stati e gli eventi della corsa, in un'unica sequenza — «fase 2 completata in 6m 32s» accanto a «3 tentativi per rate limit».

**Files:**
- Create: `app/main/run/log.ts`, `app/test/run-log.test.ts`
- Modify: `app/shared/dto.ts`, `app/shared/channels.ts`, `app/main/ipc.ts`, `side.ts`, `side.html`, `side.css`, `app/locales/*.json`

**Interfaces:**
- Produces: `export interface LogLine { at: string; kind: "state" | "event"; code: string; severity: "info" | "warning" | "error"; info: Record<string, unknown> | null }` in `dto.ts`; canale `"run.events": { request: { projectId: string }; response: LogLine[] }`; `runLog(db, projectId, limit = 200): LogLine[]` in `app/main/run/log.ts`.

- [ ] **Step 1: Il test**

```ts
  it("weaves the states and the events into one history", () => {
    // ... una fase chiusa e un evento di degradazione, con date intrecciate ...
    expect(runLog(db, "p1").map((l) => l.code))
      .toEqual(["phase.analyze.done", "chunk-exhausted", "phase.candidates.done"]);
  });

  it("holds a long run to the last two hundred, keeping the end", () => {
    // ... 250 eventi ...
    const log = runLog(db, "p1");
    expect(log).toHaveLength(200);
    expect(log.at(-1)!.code).toBe("event-249");
  });

  it("calls a degradation a warning and a failure an error", () => {
    expect(runLog(db, "p1").find((l) => l.code === "chunk-exhausted")!.severity).toBe("warning");
  });
```

- [ ] **Step 2: L'implementazione**

`runLog` legge due sorgenti e le fonde in memoria, ordinando per data:
- da `project_state`, ogni record chiuso diventa una riga con `code = "phase." + name + "." + outcome` per le fasi e `"state." + name` per gli stati del progetto, `info` quello del record;
- da `run_event` dell'ultima corsa (la query del vecchio Task 6, invariata), ogni evento diventa una riga con il suo `code` e la severità mappata (`degradation` → `warning`, `error` → `error`, altro → `info`).

Poi ordina per `at` crescente e taglia agli ultimi `limit`.

- [ ] **Step 3: La finestra**

`side.ts` carica il registro quando la scheda Log si apre e quando arriva `project.changed` per questo progetto, con lo stesso freno di un secondo delle unità. Ogni riga: l'ora locale (`Intl.DateTimeFormat` con `timeStyle: "medium"`), e la frase — `t('codes.' + code)` per gli eventi (il catalogo li ha già), `t('phase.' + name)` più l'esito per le fasi. La severità dà il colore: `--warning`, `--danger`, `--text-soft`.

- [ ] **Step 4: Verifica e commit**

```bash
git add app/main/run app/shared app/renderer/src/app/project app/test app/locales
git commit -m "feat(project): il registro racconta la corsa, stati e degradazioni insieme"
```

---

### Task 8: Gli avvisi

Le carte del disegno — errore, avvertimento, informazione — costruite da ciò che il progetto già sa.

**Files:** `side.ts`, `side.html`, `side.css`, `app/locales/*.json`, `side.spec.ts`

- [ ] **Step 1: Il test**

```ts
  it("warns that synchronised reading will not survive the translation", () => {
    const { fixture } = mount({ ...detail, hasOverlays: true });
    expect(fixture.nativeElement.querySelector("[data-testid=alert-overlays]")).not.toBeNull();
  });

  /*
   * The catalogue holds a sentence for the codes it knows (`codes.*`); an
   * engine can fail with one it does not, and a raw code on screen beats a
   * blank card. The fallback is the case worth pinning, because it is the one
   * nobody writes on purpose.
   */
  it("says why the run stopped, and shows the bare code when it has no sentence", () => {
    const { fixture } = mount({
      ...detail, state: "failed",
      phases: [{ phase: "translate", state: "failed", startedAt: null, endedAt: null,
                 done: null, total: null, info: { code: "provider-529" } }],
    });
    expect(fixture.nativeElement.querySelector("[data-testid=alert-failed]").textContent)
      .toContain("provider-529");
  });

  it("says nothing when there is nothing to say", () => {
    const { fixture } = mount({ ...detail, description: "C'è." });
    expect(fixture.nativeElement.querySelectorAll("[data-testid^=alert-]")).toHaveLength(0);
  });
```

- [ ] **Step 2: L'implementazione**

Un `alerts()` computed che ritorna al massimo tre voci: `failed` (quando `state === "failed"`, con il codice preso dalla fase fallita — che ora ce l'ha, grazie al Task 5, e reso con `t('codes.' + code)` **solo se il catalogo lo conosce**, altrimenti col codice nudo: `errors` oggi contiene una chiave sola, `noBridge`, e inventare un catalogo di errori del provider è un altro lavoro), `overlays` (quando `hasOverlays`, riusando `overlays.warning` che esiste già), `description` (quando `description === null`, riusando `project.noDescription`). Stringhe nuove: solo i tre titoli, `alerts.failed`, `alerts.overlays`, `alerts.noDescription`.

- [ ] **Step 3: Verifica e commit**

```bash
git commit -am "feat(project): la colonna dice cosa c'è da sapere prima di spendere"
```

---

### Task 9: Via la Panoramica

Quello che la Panoramica diceva sta tutto nella colonna. La scheda sparisce, e la scheda predefinita diventa Termini.

**Files:** `project.html`, `project.ts`, `project.css`, `project.spec.ts`, `app/e2e/screens.spec.ts`, `app/e2e/gates.spec.ts`, `app/locales/*.json`

- [ ] **Step 1: I test che cambiano**

In `project.spec.ts`: `expect(fixture.nativeElement.querySelector("[data-testid=tab-overview]")).toBeNull()`, più un'asserzione che la scheda aperta all'ingresso è `terms`.
In `app/e2e/screens.spec.ts`: via la voce `project-overview` dall'elenco, e **cancella** i due PNG `project-overview-{light,dark}.png`.
In `app/e2e/gates.spec.ts`: via la riga `await expect(window.getByTestId("tab-overview")).toBeVisible();`.

- [ ] **Step 2: L'implementazione**

`tabs` perde `"overview"`, `tab` parte da `"terms"`, il `@case ("overview")` e la sezione `.overview` spariscono da `project.html`, le regole `.overview*` da `project.css`. Le chiavi `project.tabs.overview`, `project.cost`, `project.layout` restano solo se qualcuno le usa: **grep prima di cancellare**.

- [ ] **Step 3: Verifica**

`npm test`, `npm run test:ui -w app`, `npm run typecheck`, screenshot rigenerati e **guardati** nei due temi: la colonna dice tutto quello che la Panoramica diceva.

- [ ] **Step 4: Commit**

```bash
git add app/renderer/src/app/project app/e2e app/locales
git commit -m "refactor(project): la panoramica era la colonna, scritta due volte"
```

---

## Autoverifica del piano

**Copertura del disegno.** Breadcrumb → Task 1. Colonna e sua elasticità → Task 2. Identità, chip, lingue, provider, descrizione con modale → Task 3. Badge, azione contestuale, elimina a icona, i cinque numeri → Task 4. Memorizzazione degli stati → Task 5. Pannello Avanzamento → Task 6. Pannello Log → Task 7. Avvisi → Task 8. Sparizione della Panoramica → Task 9.

**Non implementato di proposito, perché il programma non lo sa.** Il chip «Senza DRM»: nessuna riga guarda `META-INF/encryption.xml`, e un chip che dichiara ciò che nessuno ha controllato è una bugia con un bordo arrotondato. La lettura sincronizzata invece si fa: `hasOverlays` è un fatto che l'analisi già stabilisce. Stessa regola per il resto del mock — font, raggi, e i valori d'esempio dello script (61.049 token, «~0,42 USD», gli orari del log) sono esempi, non contratti.

**Tipi.** `StateRecord`, `enterState`, `leaveState`, `statesOf` nascono nel Task 5 e sono usati nei Task 6 e 7. `PhaseProgress`/`PhaseState` nascono nel Task 6; il fixture del Task 2 dichiara `phases: []` e `finishedAt: null` fin da subito, così i test dei task precedenti non si rompono quando i campi arrivano. `LogLine` nasce nel Task 7. `phasesOf` e `runLog` hanno un nome solo in tutto il piano.

**Il rischio della memorizzazione, dichiarato.** I libri già in libreria non hanno una storia: la migrazione ne semina una riga sola, lo stato in cui sono al momento della migrazione, datata alla loro creazione. La loro timeline mostrerà cinque fasi in attesa finché non li si fa ripartire — **onesto e brutto**, ed è la scelta giusta: l'alternativa è dedurre a ritroso da `project_phase_result` una storia che nessuno ha vissuto, cioè inventare date. Il Task 6 va guardato su un libro vecchio prima di dichiararlo finito.

**Una conseguenza che vale la pena sapere.** Con gli stati memorizzati, il rapporto (`app/main/report/build.ts`) ha una seconda fonte per i suoi tempi, oggi ricavati dalle righe di `run`. Questo piano **non** lo tocca: cambiare il rapporto mentre si costruisce la colonna sarebbe una modifica non richiesta dentro un task che parla d'altro. Vale come lavoro successivo, non come debito.
