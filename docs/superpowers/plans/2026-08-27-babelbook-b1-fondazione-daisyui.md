# B1 — La fondazione daisyUI — piano di implementazione

**Stato: in corso al 2026-08-28 — task 1–5 completati e rivisti, task 6 committato con review da fare, task 7 da fare.**

Commits: `966cb3d` (T1), `da356fc` (T2), `0e664ab` (T3), `5f4129e` (T4), `63b86aa` (T5), `08436b9` (T6). Suite verde a ogni commit. Ripresa: review del T6 (il pacchetto è già in `.superpowers/sdd/2026-08-27-babelbook-b1-fondazione-daisyui/review-63b86aa..08436b9.diff`), poi T7, review finale (base `2318a22`), aggiornamento di questa intestazione.

Cosa l'esecuzione ha cambiato o scoperto, rispetto al piano scritto:

- **Le schermate non si committano.** `app/.gitignore` ignora `e2e/screenshots/` dalla nascita del repo: le righe `git add app/e2e/screenshots` dei task 4–7 erano ineseguibili. Le PNG si rigenerano a ogni corsa e2e e restano non tracciate.
- **Il task 3 è corso in ordine**, senza slittare in fondo: i fogli dei componenti non contenevano esadecimali nemmeno prima del porto.
- **Estensioni necessarie che il piano non vedeva.** Nel T2: il selettore `:root.theme-dark` del blocco scuro è diventato `:root[data-theme="babelbook-dark"]` e il testimone di `setTheme` in `screens.spec.ts` è passato all'attributo, altrimenti ogni e2e moriva al primo cambio tema; più `wear(false)` nel catch (imposto dal test «Named, not absent»). Nel T4: `@source inline(...)` per le classi tono interpolate a runtime, `--depth`/`--noise`/`--color-accent`/`--color-secondary` nei temi (valori presi dalla tavolozza esistente), il parser e2e che impara a leggere oklab, il blocco `@layer base` transitorio per gli elementi nudi (poi svuotato dal T6 quando più nessun controllo è rimasto senza classe).
- **Il piano diceva che le spec cercano per testid e testo, non per classe:** falso per tre asserzioni (`btn--primary` in library e new-project, l'aggancio `tile__state--`), aggiornate mantenendone l'intenzione.
- **Slot di tavolozza che si spostano sui controlli daisyUI** (riempimento del bottone quieto da bianco a base-200, `btn-error` pieno, binario della progress a tinta del primario, sottolineatura della tab attiva da accent a base-content): identità dei controlli della libreria, valori sempre nel tema. Nessun valore hex nuovo.
- **Per il futuro (B2/C):** il bordo tratteggiato della voce non servita è invisibile sotto `.btn:disabled`; il warning `initial` del budget Angular (524 kB > 500 kB) scende da daisyUI.
- **Ambiente:** `xvfb-run` non è installato su questa Fedora — l'e2e gira su `DISPLAY=:0` con lo stesso esito. Per tutto il piano ha lavorato in parallelo un altro worker su `core/` e `app/engine/` (reasoning-tokens, non committato): i commit B1 lo escludono.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tailwind e daisyUI diventano la fondazione dei controlli, le dodici schermate passano alle sue classi, e l'applicazione fa esattamente quello che faceva prima.

**Architecture:** Tailwind CSS 4 entra nella catena di build via PostCSS; daisyUI è il suo plugin. La tavolozza non cambia: si dichiara un tema daisyUI che riproduce gli stessi colori che `styles.css` ha oggi, così le schermate rigenerate differiscono per forma dei controlli e non per colore. Il tema passa dalla classe `.theme-dark` all'attributo `data-theme`, deciso da `nativeTheme` come adesso. Il CSS per componente si svuota; ciò che resta è layout, non aspetto.

**Tech Stack:** Angular 22.1, Tailwind CSS 4.3.3, daisyUI 5.7.22, `@tailwindcss/postcss`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-27-guscio-e-libreria-design.md`

## Global Constraints

- **Nessuna funzione nuova.** Se qualcosa si comporta diversamente da prima, è un difetto di questo lavoro, non un miglioramento. Il guscio, i gruppi, l'eliminazione e l'esportazione sono B2.
- **La tavolozza non cambia.** I valori del tema sono, alla cifra, quelli che `app/renderer/src/styles.css` dichiara oggi. Un cambiamento per volta: qui cambia la forma dei controlli, non il colore.
- **Il cursore resta la freccia.** Nessun `cursor: pointer` entra nel progetto — è una scelta di carattere, non un dettaglio, e sopravvive al cambio di fondazione.
- **`data-theme` sostituisce `.theme-dark`**, ma non il meccanismo: `nativeTheme` decide, l'evento `theme.changed` tiene aggiornata la finestra aperta (electron#22211).
- Ogni stringa mostrata all'utente esiste in `app/locales/en.json` **e** `app/locales/it.json`. Questo lavoro non ne aggiunge nessuna.
- Codice e commenti in inglese.
- Comandi dalla radice del repo, salvo dove indicato. Node 24.18.0 (`fnm use`).

---

### Task 1: Tailwind e daisyUI nella catena di build

`angular.json` dichiara un solo foglio globale e non esiste alcuna configurazione PostCSS. Questo task ne aggiunge una e dichiara il tema, senza ancora cambiare una sola schermata.

**Files:**
- Create: `app/.postcssrc.json`
- Modify: `app/renderer/src/styles.css`
- Modify: `app/package.json`
- Create: `app/test/foundation.test.ts`

**Interfaces:**
- Consumes: niente
- Produces: il tema daisyUI `babelbook` (chiaro) e `babelbook-dark`, selezionati da `data-theme`

- [ ] **Step 1: Installa Tailwind e daisyUI**

```bash
npm install -w app --save-dev tailwindcss@^4.3.3 @tailwindcss/postcss@^4.3.3 daisyui@^5.7.22
```

Restano in `devDependencies`: producono CSS a build time e non vengono richiesti a runtime.

- [ ] **Step 2: Scrivi il test che fallisce**

`app/test/foundation.test.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const STYLES = "app/renderer/src/styles.css";

/**
 * The foundation, after daisyUI.
 *
 * The palette is no longer a list of names this application invented: it is
 * daisyUI's, filled with this application's values. These tests hold the two
 * things that would silently break — the plugin being loaded at all, and the
 * theme being chosen by the attribute the main process actually sets.
 */
describe("the foundation", () => {
  it("loads tailwind and daisyui, and declares both themes", async () => {
    const css = await readFile(STYLES, "utf8");

    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain('@plugin "daisyui"');
    expect(css).toMatch(/name:\s*"babelbook"/);
    expect(css).toMatch(/name:\s*"babelbook-dark"/);
  });

  it("keeps the palette it had, so this change is one change", async () => {
    const css = await readFile(STYLES, "utf8");

    // The values are the ones the application shipped before daisyUI. A screen
    // that comes back a different colour means the port changed two things at
    // once, and the screenshots stop being reviewable.
    expect(css).toContain("#2563eb"); // accent, light
    expect(css).toContain("#0f172a"); // surface, dark
    expect(css).toContain("#b91c1c"); // danger, light
  });
});
```

- [ ] **Step 3: Lancialo e guardalo fallire**

```bash
npx vitest run app/test/foundation.test.ts
```

Attesa: FAIL, `expected '…' to contain '@import "tailwindcss"'`.

- [ ] **Step 4: Configura PostCSS e dichiara i temi**

`app/.postcssrc.json`:

```json
{
  "plugins": {
    "@tailwindcss/postcss": {}
  }
}
```

In testa a `app/renderer/src/styles.css`, prima di tutto il resto:

```css
@import "tailwindcss";
@plugin "daisyui" {
  themes: babelbook --default, babelbook-dark;
}

/*
 * The palette, unchanged, in daisyUI's names.
 *
 * These are the values this application shipped before daisyUI existed here:
 * the port changes the shape of the controls and nothing else, so a screenshot
 * that comes back a different colour is a mistake rather than a redesign.
 */
@plugin "daisyui/theme" {
  name: "babelbook";
  default: true;
  color-scheme: light;

  --color-base-100: #ffffff;
  --color-base-200: #f3f4f6;
  --color-base-300: #e5e7eb;
  --color-base-content: #111827;

  --color-primary: #2563eb;
  --color-primary-content: #ffffff;
  --color-neutral: #4b5563;
  --color-neutral-content: #ffffff;

  --color-error: #b91c1c;
  --color-error-content: #ffffff;
  --color-warning: #b45309;
  --color-warning-content: #ffffff;
  --color-success: #166534;
  --color-success-content: #ffffff;
  --color-info: #2563eb;
  --color-info-content: #ffffff;

  --radius-box: 6px;
  --radius-field: 6px;
  --radius-selector: 6px;
  --border: 1px;
}

@plugin "daisyui/theme" {
  name: "babelbook-dark";
  color-scheme: dark;

  --color-base-100: #0f172a;
  --color-base-200: #1e293b;
  --color-base-300: #334155;
  --color-base-content: #e2e8f0;

  --color-primary: #60a5fa;
  --color-primary-content: #0f172a;
  --color-neutral: #cbd5e1;
  --color-neutral-content: #0f172a;

  --color-error: #f87171;
  --color-error-content: #0f172a;
  --color-warning: #fbbf24;
  --color-warning-content: #0f172a;
  --color-success: #86efac;
  --color-success-content: #0f172a;
  --color-info: #60a5fa;
  --color-info-content: #0f172a;

  --radius-box: 6px;
  --radius-field: 6px;
  --radius-selector: 6px;
  --border: 1px;
}
```

**Le variabili che daisyUI non ha restano.** `--text-soft`, `--text-muted`,
`--text-faint`, `--accent-soft`, `--accent-soft-text`, `--accent-wash`,
`--accent-line`, `--warning-soft`, `--warning-box`, `--warning-line`,
`--ok-soft`, `--ok-line` non hanno un equivalente nel tema di daisyUI e
continuano a vivere in `:root` e nel blocco scuro, come oggi. Sono sfumature
che i componenti usano; toglierle sarebbe un secondo cambiamento.

- [ ] **Step 5: Lancialo e guardalo passare, poi costruisci**

```bash
npx vitest run app/test/foundation.test.ts
cd app && npm run build
```

Attesa: test verdi, build completa. Guarda la dimensione del bundle CSS
riportata dal builder: era `1.76 kB`, e con Tailwind e daisyUI crescerà. Se
supera i 200 kB, il tree-shaking di Tailwind non sta vedendo i template e va
sistemato prima di proseguire — non dopo dodici schermate.

- [ ] **Step 6: Commit**

```bash
git add app/.postcssrc.json app/package.json package-lock.json app/renderer/src/styles.css app/test/foundation.test.ts
git commit -m "build(renderer): tailwind e daisyui, con la tavolozza che c'era gia'"
```

---

### Task 2: Il tema si sceglie con `data-theme`

daisyUI legge l'attributo; oggi il renderer riceve una classe. Cambia il modo, non chi decide.

**Files:**
- Modify: `app/renderer/src/app/app.config.ts` (`settleAppearance`)
- Modify: `app/renderer/src/app/app.config.spec.ts`
- Modify: `app/main/window.ts` (il colore di fondo della finestra)

**Interfaces:**
- Consumes: i temi `babelbook` e `babelbook-dark` (Task 1)
- Produces: `settleAppearance` scrive `document.documentElement.dataset["theme"]`

- [ ] **Step 1: Scrivi il test che fallisce**

In `app/renderer/src/app/app.config.spec.ts`, sostituisci le tre asserzioni che
leggono `classList.contains("theme-dark")` con l'attributo, e aggiungi il caso
chiaro, che prima non c'era:

```typescript
it("wears the theme the main process reports, and the stored language", async () => {
  const { ipc, transloco } = scene();

  await settleAppearance(TestBed.inject(IpcService), transloco);

  expect(document.documentElement.dataset["theme"]).toBe("babelbook-dark");
  expect(transloco.getActiveLang()).toBe("en");
  expect(ipc.invoke).toHaveBeenCalledWith("ui.theme", undefined);
});

it("wears the light theme when the system is light", async () => {
  const ipc = { on: () => () => {}, invoke: vi.fn(async (channel: string) =>
    channel === "ui.theme" ? { dark: false } : stored) };
  TestBed.configureTestingModule({
    providers: [...provideI18n("it"), { provide: IpcService, useValue: ipc }],
  });

  await settleAppearance(TestBed.inject(IpcService), TestBed.inject(TranslocoService));

  // Named, not absent: daisyUI picks a theme by attribute, and no attribute
  // means whatever it considers the default — which is not a decision anyone
  // in this application made.
  expect(document.documentElement.dataset["theme"]).toBe("babelbook");
});
```

Nei due test rimanenti sostituisci `classList.contains("theme-dark")` con
`dataset["theme"]`, attendendosi `"babelbook-dark"` e — nel test senza bridge —
`"babelbook"`.

- [ ] **Step 2: Lancialo e guardalo fallire**

Da `app/`:

```bash
npx ng test
```

Attesa: FAIL, `expected undefined to be 'babelbook-dark'`.

- [ ] **Step 3: Scrivi l'attributo invece della classe**

In `app/renderer/src/app/app.config.ts`, dentro `settleAppearance`:

```typescript
  const wear = (dark: boolean): void => {
    // daisyUI chooses by attribute. Both names are written explicitly: leaving
    // the attribute off in the light case would hand the choice to whatever
    // daisyUI considers the default, which is not a decision made here.
    document.documentElement.dataset["theme"] = dark ? "babelbook-dark" : "babelbook";
  };
```

In `app/main/window.ts`, il colore di fondo della finestra resta deciso da
`nativeTheme` e va allineato ai due valori del tema: `#0f172a` scuro,
`#ffffff` chiaro. Se già lo sono, non toccare nulla.

- [ ] **Step 4: Lancialo e guardalo passare**

Da `app/`:

```bash
npx ng test
```

Attesa: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/app.config.ts app/renderer/src/app/app.config.spec.ts app/main/window.ts
git commit -m "feat(renderer): il tema si sceglie con data-theme, deciso da chi lo decideva prima"
```

---

### Task 3: `styles.test.ts` riscritto sulla fondazione nuova

Dei suoi dodici test, quelli che sorvegliano il CSS per componente descrivono una disciplina che daisyUI rende superflua: fra poco quel CSS quasi non esisterà. Vanno sostituiti, non cancellati: ciò che sorvegliavano — una tavolozza sola, una forma sola per i controlli — resta vero e cambia solo il modo di dirlo.

**Files:**
- Modify: `app/test/styles.test.ts`

**Interfaces:**
- Consumes: `foundation.test.ts` (Task 1), che copre già plugin e temi
- Produces: nessuna interfaccia

- [ ] **Step 1: Riscrivi il file**

Sostituisci l'intero contenuto di `app/test/styles.test.ts`:

```typescript
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = "app/renderer/src/styles.css";

async function cssFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await cssFiles(path)));
    else if (entry.name.endsWith(".css")) out.push(path);
  }
  return out;
}

/**
 * What survives the change of foundation.
 *
 * daisyUI supplies the shape of the controls, so the rules that used to hold
 * one padding and one radius have nothing left to hold. Two things do survive,
 * because they are decisions rather than implementation: every colour comes
 * from one place, and the cursor stays the arrow.
 */
describe("the stylesheets", () => {
  it("keep every colour in the global sheet, where the themes are", async () => {
    const files = (await cssFiles("app/renderer/src")).filter((path) => path !== STYLES);

    const offenders: string[] = [];
    for (const path of files) {
      const css = await readFile(path, "utf8");
      for (const match of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never point the cursor on a button: the arrow, like a native application", async () => {
    const offenders: string[] = [];
    for (const path of await cssFiles("app/renderer/src")) {
      if ((await readFile(path, "utf8")).includes("cursor: pointer")) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });

  it("gives the window a background that matches the theme it opens in", async () => {
    const source = await readFile("app/main/window.ts", "utf8");

    // A white flash before the renderer paints is the window's own background
    // showing through: it must be the theme's colour, decided by nativeTheme.
    expect(source).toContain("backgroundColor");
    expect(source).toContain("nativeTheme");
  });
});
```

I test spariti — quelli su `.btn`, sulla regola condivisa dei campi, sul
padding nei componenti e sulla griglia della libreria — non hanno più un
soggetto: `.btn` è di daisyUI, i campi li veste `input`, e la griglia della
libreria la riscrive B2. Il test sul cursore resta perché quella è una scelta.

- [ ] **Step 2: Lancialo e guardalo passare**

```bash
npx vitest run app/test/styles.test.ts app/test/foundation.test.ts
```

Attesa: PASS. Se il primo test elenca esadecimali, sono i fogli dei componenti
che ancora ne contengono: è il lavoro dei task seguenti e per ora vanno
lasciati. In quel caso **fermati qui e fai questo task per ultimo**, dopo il
Task 6.

- [ ] **Step 3: Commit**

```bash
git add app/test/styles.test.ts
git commit -m "test(styles): la rete sotto la fondazione nuova, senza cio' che non ha piu' soggetto"
```

---

### Task 4: La libreria e «Nuovo progetto»

Due schermate, i controlli di daisyUI, nessun comportamento nuovo.

**Files:**
- Modify: `app/renderer/src/app/library/library.html`, `library.css`
- Modify: `app/renderer/src/app/new-project/new-project.html`, `new-project.css`
- Modify: `app/renderer/src/app/app.css`

**Interfaces:**
- Consumes: i temi (Task 1), l'attributo (Task 2)
- Produces: nessuna interfaccia

- [ ] **Step 1: Porta i controlli**

La corrispondenza, che vale per tutte le schermate di questo piano e dei
seguenti:

| prima | dopo |
|---|---|
| `class="btn btn--primary"` | `class="btn btn-primary"` |
| `class="btn btn--danger"` | `class="btn btn-error"` |
| `class="btn"` | `class="btn"` |
| `<button>` senza classe | `class="btn"` |
| `<input type="text\|password">` | `class="input"` |
| `<input type="checkbox">` | `class="checkbox"` |
| `<select>` | `class="select"` |
| `<textarea>` | `class="textarea"` |
| una tile della libreria | `class="card bg-base-100 border border-base-300"` |
| un'etichetta di stato | `class="badge"` |

Dai fogli `library.css`, `new-project.css` e `app.css` togli tutto ciò che
descriveva l'aspetto dei controlli — bordi, padding, raggi, sfondi, colori — e
lascia solo il layout: griglie, `gap`, allineamenti. Se un file resta vuoto,
cancellalo e togli il suo `styleUrl` dal componente.

- [ ] **Step 2: Lancia i test di componente**

Da `app/`:

```bash
npx ng test
```

Attesa: PASS. Le spec cercano per `data-testid` e per testo, non per classe:
se una fallisce, il template ha perso un `data-testid` nel porto e va rimesso.

- [ ] **Step 3: Guarda le due schermate**

Da `app/`:

```bash
npm run build
xvfb-run --auto-servernum npx playwright test e2e/screens.spec.ts
```

Poi **apri** `e2e/screenshots/library-light.png`, `library-dark.png`,
`new-project-light.png`, `new-project-dark.png`. I colori devono essere quelli
di prima; a cambiare sono bordi, altezze e raggi dei controlli. Un colore
diverso significa che il tema del Task 1 non copre un caso, e va sistemato lì.

- [ ] **Step 4: Commit**

```bash
git add app/renderer/src/app/library app/renderer/src/app/new-project app/renderer/src/app/app.css app/e2e/screenshots
git commit -m "feat(ui): la libreria e nuovo progetto sui controlli di daisyui"
```

---

### Task 5: Il progetto e le sue quattro schede

**Files:**
- Modify: `app/renderer/src/app/project/project.html`, `project.css`
- Modify: `app/renderer/src/app/project/report/report.html`, `report.css`
- Modify: `app/renderer/src/app/project/terms/terms.html`, `terms.css`
- Modify: `app/renderer/src/app/project/units/units.html`, `units.css`
- Modify: `app/renderer/src/app/project/exclusions/exclusions.html`, `exclusions.css`

**Interfaces:**
- Consumes: la corrispondenza dei controlli (Task 4)
- Produces: nessuna interfaccia

- [ ] **Step 1: Porta i controlli, con due aggiunte**

Applica la stessa corrispondenza del Task 4. Due elementi compaiono solo qui:

| prima | dopo |
|---|---|
| la striscia di schede `.project__tabs` | `class="tabs tabs-border"`, ogni scheda `class="tab"`, quella attiva `tab-active` |
| l'avanzamento di una traduzione | `class="progress"` |

La striscia di schede **resta**: è la navigazione dentro un progetto, non nelle
impostazioni, e B2 non la tocca.

- [ ] **Step 2: Lancia i test di componente**

Da `app/`:

```bash
npx ng test
```

Attesa: PASS.

- [ ] **Step 3: Guarda le schermate del progetto**

Da `app/`:

```bash
npm run build
xvfb-run --auto-servernum npx playwright test e2e/screens.spec.ts
```

Apri le otto immagini `project-overview`, `project-units`, `project-terms`,
`project-exclusions`, `project-report`, in chiaro e scuro.

- [ ] **Step 4: Commit**

```bash
git add app/renderer/src/app/project app/e2e/screenshots
git commit -m "feat(ui): il progetto e le sue schede sui controlli di daisyui"
```

---

### Task 6: Le impostazioni e le sue quattro sezioni

**Files:**
- Modify: `app/renderer/src/app/settings/settings.html`, `settings.css`
- Modify: `app/renderer/src/app/settings/providers.html`, `providers.css`
- Modify: `app/renderer/src/app/settings/glossaries.html`, `glossaries.css`
- Modify: `app/renderer/src/app/settings/preferences.html`, `preferences.css`

**Interfaces:**
- Consumes: la corrispondenza dei controlli (Task 4)
- Produces: nessuna interfaccia

- [ ] **Step 1: Porta i controlli**

Stessa corrispondenza. Le pastiglie della ricerca provider —
`.providers__runtime`, `.providers__entry`, `.providers__preset` — diventano
`class="btn btn-sm rounded-full"`, che è la forma che avevano.

La striscia `.settings__sections` **resta per ora**, portata a
`class="tabs tabs-border"`: sparisce in B2, quando la colonna la sostituisce.
Toglierla qui lascerebbe le impostazioni senza navigazione per la durata di due
piani.

- [ ] **Step 2: Lancia i test di componente**

Da `app/`:

```bash
npx ng test
```

Attesa: PASS. `providers.spec.ts` è la più esigente delle spec: se fallisce,
guarda per prima cosa i `data-testid` delle pastiglie.

- [ ] **Step 3: Guarda le otto schermate delle impostazioni**

Da `app/`:

```bash
npm run build
xvfb-run --auto-servernum npx playwright test e2e/screens.spec.ts
```

Apri `settings-providers`, `settings-glossaries`, `settings-translation`,
`settings-application`, in chiaro e scuro.

- [ ] **Step 4: Commit**

```bash
git add app/renderer/src/app/settings app/e2e/screenshots
git commit -m "feat(ui): le impostazioni sui controlli di daisyui"
```

---

### Task 7: Tutto insieme, e le ventidue schermate

L'ultimo task non scrive codice: verifica che il porto sia stato un porto.

**Files:**
- Modify: `app/e2e/screenshots/*` (rigenerate)

**Interfaces:**
- Consumes: tutti i task precedenti
- Produces: niente

- [ ] **Step 1: La suite intera**

Dalla radice:

```bash
npm run typecheck
npm test -w core
npm test -w app
```

Attesa: tutto verde.

- [ ] **Step 2: Le schermate e i cammini**

Da `app/`:

```bash
xvfb-run --auto-servernum npm run test:e2e
```

Attesa: 12 passati, 1 saltato (`packaged.spec.ts`, che chiede
`BABELBOOK_PACKAGED`).

- [ ] **Step 3: Guardale tutte e ventidue**

Apri ogni file di `app/e2e/screenshots/` e confrontalo con quello che ricordi.
Cerca in particolare tre cose:

1. **Un colore diverso** → il tema del Task 1 non copre un caso.
2. **Un controllo che non ha preso forma** → un template ha perso una classe.
3. **Uno spazio che si è chiuso o aperto** → un foglio di componente ha perso
   una regola di layout insieme a quelle di aspetto.

Nessuna di queste tre è accettabile in questo piano: qui l'aspetto dei
controlli è l'unica cosa che aveva il permesso di cambiare.

- [ ] **Step 4: Commit**

```bash
git add app/e2e/screenshots
git commit -m "test(e2e): le ventidue schermate dopo il porto, in entrambi i temi"
```
