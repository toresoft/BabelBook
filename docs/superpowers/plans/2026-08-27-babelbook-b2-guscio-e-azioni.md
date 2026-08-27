# B2 — Il guscio e le azioni — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una colonna a sinistra che non se ne va mai, gli undici stati raccolti in cinque voci col loro conteggio, un progetto che si può eliminare e un libro tradotto che si può esportare.

**Architecture:** `app.html` smette di essere un `<router-outlet />` nudo e diventa il guscio: colonna a sinistra, pannello a destra. I gruppi sono rotte — `/projects/:bucket` — e il filtro si applica in SQL, non nel renderer. La mappa stato → gruppo vive in un file solo, condivisa fra il conteggio e il filtro. Il ritorno da «Nuovo progetto» non si corregge: con il guscio in piedi smette di poter esistere.

**Tech Stack:** Angular 22.1, daisyUI 5, SQLite (`node:sqlite`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-27-guscio-e-libreria-design.md`

## Global Constraints

- **Parte da un albero dove B1 è atterrato.** I componenti usati qui — `menu`, `badge`, `card`, `divider` — sono daisyUI, e senza B1 non esistono.
- **Il filtro si applica in SQL**, mai nel renderer: filtrare in pagina significherebbe trasferire l'intera libreria a ogni clic e tenere due verità sullo stesso insieme.
- **La mappa stato → gruppo è scritta una volta sola** e importata da entrambe le parti. Due copie sono due copie che divergono.
- **I gruppi non partizionano.** `new`, `needs-language`, `ready`, `incomplete` e `failed` si vedono solo sotto «Progetti». È una decisione, non una dimenticanza: non aggiungere voci per coprirli.
- Ogni stringa mostrata all'utente esiste in `app/locales/en.json` **e** `app/locales/it.json`.
- Codice e commenti in inglese. Comandi dalla radice del repo salvo dove indicato. Node 24.18.0.

---

### Task 1: I gruppi, in SQL e in un posto solo

Prima la parte che non si vede: la mappa, il filtro e il conteggio. Senza, la colonna sarebbe cinque collegamenti che mostrano tutti la stessa cosa.

**Files:**
- Create: `app/shared/buckets.ts`
- Modify: `app/main/projects/query.ts`
- Modify: `app/shared/channels.ts`
- Modify: `app/main/ipc.ts`
- Modify: `app/test/query.test.ts`

**Interfaces:**
- Consumes: `ProjectState` da `core/workflow/project.machine.ts`
- Produces:
  - `type Bucket = "all" | "to-approve" | "running" | "paused" | "done"`
  - `const BUCKETS: readonly Bucket[]`
  - `function statesOf(bucket: Bucket): readonly ProjectState[]` — vuoto per `all`
  - `listProjects(db, query: { search?: string; bucket?: Bucket }): ProjectSummary[]`
  - canale `projects.counts`: `{ req: undefined; res: Record<Bucket, number> }`

- [ ] **Step 1: Scrivi i test che falliscono**

In `app/test/query.test.ts`, in coda:

```typescript
import { BUCKETS, statesOf } from "../shared/buckets.ts";
import { countProjects, listProjects } from "../main/projects/query.ts";

/**
 * Eleven states, five names.
 *
 * The grouping is the only thing the column teaches, so it is the thing worth
 * pinning: a state that quietly falls out of its group makes a project
 * invisible to the person looking for it.
 */
describe("the groups of the library", () => {
  it("puts the two gates together, and nothing else with them", () => {
    expect([...statesOf("to-approve")].sort()).toEqual(["waiting-code", "waiting-terms"]);
  });

  it("counts composing as running, because the book is still moving", () => {
    expect([...statesOf("running")].sort()).toEqual(["composing", "running"]);
  });

  it("filters the library to the group asked for", async () => {
    const db = await aLibraryOfEveryState();

    const gates = listProjects(db, { bucket: "to-approve" });
    const all = listProjects(db, { bucket: "all" });

    expect(gates.map((p) => p.state).sort()).toEqual(["waiting-code", "waiting-terms"]);
    expect(all).toHaveLength(11);
  });

  it("counts each group, and counts every project under Projects", async () => {
    const db = await aLibraryOfEveryState();

    const counts = countProjects(db);

    expect(counts.all).toBe(11);
    expect(counts["to-approve"]).toBe(2);
    expect(counts.running).toBe(2);
    expect(counts.paused).toBe(1);
    expect(counts.done).toBe(1);
    // The groups do not partition, and that is deliberate: five of the eleven
    // live only under Projects.
    expect(BUCKETS.reduce((n, b) => n + (b === "all" ? 0 : counts[b]), 0)).toBe(6);
  });
});
```

`aLibraryOfEveryState()` è un aiuto locale da scrivere accanto agli altri del
file: apre un database in memoria, applica le migrazioni e inserisce undici
progetti, uno per stato, riusando la forma di inserimento che il file già usa
per i suoi test.

- [ ] **Step 2: Lanciali e guardali fallire**

```bash
npx vitest run app/test/query.test.ts
```

Attesa: FAIL, `Failed to resolve import "../shared/buckets.ts"`.

- [ ] **Step 3: Scrivi la mappa, il filtro e il conteggio**

`app/shared/buckets.ts`:

```typescript
import type { ProjectState } from "../../core/workflow/project.machine.ts";

/**
 * The eleven states of a project, under the five names a person looks for.
 *
 * The groups do not partition, and that is the design: `new`,
 * `needs-language`, `ready`, `incomplete` and `failed` appear only under
 * Projects, with their own label on the tile. A group earns its place by
 * answering a question someone actually asks — *what is waiting for me?*,
 * *what is running?* — and "not started yet" is not one of them: a project
 * just created is already being looked at.
 *
 * `to-approve` is the group that justifies the extra name. Those two states
 * are the only ones in which a project will never move on its own, and
 * without a place of their own a book stalled at a gate has nowhere to be
 * found.
 */
export type Bucket = "all" | "to-approve" | "running" | "paused" | "done";

export const BUCKETS: readonly Bucket[] = ["all", "to-approve", "running", "paused", "done"];

const STATES: Record<Bucket, readonly ProjectState[]> = {
  all: [],
  "to-approve": ["waiting-terms", "waiting-code"],
  running: ["running", "composing"],
  paused: ["paused"],
  done: ["done"],
};

/** The states a group holds. Empty for `all`, which holds them all. */
export function statesOf(bucket: Bucket): readonly ProjectState[] {
  return STATES[bucket];
}

export function isBucket(value: string): value is Bucket {
  return (BUCKETS as readonly string[]).includes(value);
}
```

In `app/main/projects/query.ts`, `listProjects` cambia firma e guadagna un
`WHERE`:

```typescript
export interface LibraryQuery {
  search?: string;
  bucket?: Bucket;
}

export function listProjects(db: DatabaseSync, query: LibraryQuery = {}): ProjectSummary[] {
  const search = query.search?.trim() ?? "";
  const pattern = search === "" ? null : `%${search}%`;

  // The group is a list of states, expanded into placeholders: filtering in
  // the renderer would ship the whole library on every click and keep two
  // truths about one set.
  const states = statesOf(query.bucket ?? "all");
  const holes = states.map(() => "?").join(",");
  const clause = states.length === 0 ? "" : ` AND p.state IN (${holes})`;
```

Il resto della query resta identico: al `WHERE (? IS NULL OR lower(p.title)
LIKE lower(?))` si aggiunge `clause`, e ai parametri si accodano gli stati.

Nello stesso file, il conteggio:

```typescript
/**
 * How many projects each group holds, in one query.
 *
 * The column shows five numbers and the library may be long, so the states are
 * counted by the database and grouped here — never eleven queries, and never
 * the whole library shipped to be counted in the window.
 */
export function countProjects(db: DatabaseSync): Record<Bucket, number> {
  const rows = db.prepare("SELECT state, count(*) AS n FROM project GROUP BY state")
    .all() as Array<{ state: ProjectState; n: number }>;

  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const row of rows) {
    counts.all += row.n;
    for (const bucket of BUCKETS) {
      if (bucket !== "all" && statesOf(bucket).includes(row.state)) counts[bucket] += row.n;
    }
  }
  return counts;
}
```

In `app/shared/channels.ts`, il canale della lista prende il gruppo e ne nasce
uno nuovo:

```typescript
  "projects.list": { req: { filter?: string; bucket?: Bucket }; res: ProjectSummary[] };
  "projects.counts": { req: undefined; res: Record<Bucket, number> };
```

In `app/main/ipc.ts`, l'handler passa entrambi e ne aggiunge uno:

```typescript
    "projects.list": async ({ filter, bucket }) =>
      listProjects(deps.db, { ...(filter === undefined ? {} : { search: filter }), ...(bucket === undefined ? {} : { bucket }) }),
    "projects.counts": async () => countProjects(deps.db),
```

- [ ] **Step 4: Lanciali e guardali passare**

```bash
npx vitest run app/test/query.test.ts app/test/ipc.test.ts
```

Attesa: PASS. `ipc.test.ts` verifica che le chiavi degli handler siano
esattamente i canali dichiarati: se fallisce, `projects.counts` manca da una
delle due parti.

- [ ] **Step 5: Commit**

```bash
git add app/shared/buckets.ts app/shared/channels.ts app/main/projects/query.ts app/main/ipc.ts app/test/query.test.ts
git commit -m "feat(library): undici stati sotto cinque nomi, contati e filtrati dal database"
```

---

### Task 2: Le rotte dei gruppi e delle sezioni

**Files:**
- Modify: `app/renderer/src/app/app.routes.ts`
- Modify: `app/renderer/src/app/library/library.ts`
- Modify: `app/renderer/src/app/settings/settings.ts`

**Interfaces:**
- Consumes: `Bucket`, `isBucket` (Task 1)
- Produces: `Library` con input `bucket: string`; `Settings` con input `section: string`

- [ ] **Step 1: Scrivi il test che fallisce**

In `app/renderer/src/app/library/library.spec.ts`:

```typescript
it("asks the main process for the group it was routed to", async () => {
  const { fixture, invoke } = mount();
  fixture.componentRef.setInput("bucket", "to-approve");
  await fixture.whenStable();

  // The group travels to the database, not to a filter in the window: the
  // counts in the column and the rows in the grid must be the same truth.
  expect(calls(invoke, "projects.list").at(-1)![1]).toMatchObject({ bucket: "to-approve" });
});
```

- [ ] **Step 2: Lancialo e guardalo fallire**

Da `app/`: `npx ng test`. Attesa: FAIL — `Library` non ha un input `bucket`.

- [ ] **Step 3: Aggiungi le rotte e gli input**

`app/renderer/src/app/app.routes.ts`:

```typescript
export const routes: Routes = [
  { path: "", pathMatch: "full", redirectTo: "projects/all" },
  // `:bucket` and `:section` reach the components as inputs, via
  // withComponentInputBinding — the same way `:id` already does.
  { path: "projects/:bucket", component: Library },
  { path: "new", component: NewProject },
  { path: "project/:id", component: Project },
  { path: "settings/:section", component: Settings },
  { path: "settings", pathMatch: "full", redirectTo: "settings/providers" },
  { path: "**", redirectTo: "projects/all" },
];
```

In `Library`, un input e la sua lettura:

```typescript
  readonly bucket = input<string>("all");

  constructor() {
    // A route change is a new question for the database, not a new component.
    effect(() => {
      this.bucket();
      void this.reload();
    });
```

e in `reload`:

```typescript
    const bucket = isBucket(this.bucket()) ? this.bucket() : "all";
    this.projects.set(await this.#ipc.invoke("projects.list", { filter: this.filter(), bucket }));
```

In `Settings`, lo stesso con `section`, che sostituisce il signal interno con
cui oggi sceglie la scheda attiva.

- [ ] **Step 4: Lancialo e guardalo passare**

Da `app/`: `npx ng test`. Attesa: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/app.routes.ts app/renderer/src/app/library app/renderer/src/app/settings/settings.ts
git commit -m "feat(ui): i gruppi e le sezioni sono rotte, non stato di un componente"
```

---

### Task 3: Il guscio

**Files:**
- Modify: `app/renderer/src/app/app.html`, `app.ts`, `app.css`
- Modify: `app/locales/en.json`, `app/locales/it.json`
- Create: `app/renderer/src/app/app.spec.ts`

**Interfaces:**
- Consumes: `BUCKETS`, il canale `projects.counts` (Task 1), le rotte (Task 2)
- Produces: nessuna interfaccia

- [ ] **Step 1: Scrivi il test che fallisce**

`app/renderer/src/app/app.spec.ts`:

```typescript
/**
 * The shell that never leaves.
 *
 * The defect this replaces was not a missing button: entering "New project"
 * left nothing on screen to go back to, because the Cancel inside the form
 * appears only after an EPUB has been analysed. A column that never goes away
 * does not fix that — it makes it unable to happen, and this is the assertion
 * that says so.
 */
it("keeps the column standing on the screen with no way out of its own", async () => {
  const { fixture, router } = mount();
  await router.navigateByUrl("/new");
  await fixture.whenStable();
  fixture.detectChanges();

  expect(fixture.nativeElement.querySelector("[data-testid=shell-nav]")).not.toBeNull();
  expect(fixture.nativeElement.querySelector("[data-testid=nav-all]")).not.toBeNull();
});

it("shows each group's count beside its name", async () => {
  const { fixture } = mount({ "projects.counts": { all: 7, "to-approve": 2, running: 1, paused: 0, done: 4 } });
  await fixture.whenStable();
  fixture.detectChanges();

  expect(fixture.nativeElement.querySelector("[data-testid=count-to-approve]").textContent).toContain("2");
});
```

`mount` segue la forma di `providers.spec.ts`: il finto bridge installato su
`window.babelbook`, `provideI18n("it")`, e in più `provideRouter(routes)`.

- [ ] **Step 2: Lancialo e guardalo fallire**

Da `app/`: `npx ng test`. Attesa: FAIL — nessun `shell-nav` nel DOM.

- [ ] **Step 3: Costruisci il guscio**

`app/renderer/src/app/app.html`:

```html
<div class="flex h-screen" *transloco="let t">
  <aside class="w-56 shrink-0 overflow-y-auto border-r border-base-300 bg-base-200"
         data-testid="shell-nav">
    <ul class="menu w-full">
      @for (bucket of buckets; track bucket) {
        <li>
          <a [routerLink]="['/projects', bucket]" routerLinkActive="menu-active"
             [attr.data-testid]="'nav-' + bucket">
            <span class="grow">{{ t('nav.' + bucket) }}</span>
            <span class="badge badge-sm" [attr.data-testid]="'count-' + bucket">
              {{ counts()[bucket] }}
            </span>
          </a>
        </li>
      }
    </ul>

    <div class="divider my-1"></div>

    <ul class="menu w-full">
      <li class="menu-title">{{ t('nav.settings') }}</li>
      @for (section of sections; track section) {
        <li>
          <a [routerLink]="['/settings', section]" routerLinkActive="menu-active"
             [attr.data-testid]="'nav-' + section">
            {{ t('nav.' + section) }}
          </a>
        </li>
      }
    </ul>
  </aside>

  <main class="grow overflow-y-auto p-6">
    <router-outlet />
  </main>
</div>
```

`app.ts` porta le due liste e i conteggi, e li tiene aggiornati sull'evento che
la libreria già ascolta:

```typescript
export class App implements OnDestroy {
  protected readonly buckets = BUCKETS;
  protected readonly sections = ["providers", "glossaries", "translation", "application"] as const;
  protected readonly counts = signal<Record<Bucket, number>>(
    Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>,
  );

  #ipc = inject(IpcService);
  #off: Array<() => void> = [];

  constructor() {
    void this.reload();
    // The counts are as perishable as the library itself: a run that finishes
    // moves a project from one group to another, and a column showing stale
    // numbers is worse than one showing none.
    this.#off.push(this.#ipc.on("project.changed", () => void this.reload()));
  }

  ngOnDestroy(): void {
    for (const off of this.#off) off();
  }

  private async reload(): Promise<void> {
    try {
      this.counts.set(await this.#ipc.invoke("projects.counts", undefined));
    } catch {
      // No bridge — a component test. Zeroes are the honest placeholder.
    }
  }
}
```

Le stringhe nuove, in `it.json` sotto una chiave `nav`:

```json
  "nav": {
    "all": "Progetti",
    "to-approve": "Da approvare",
    "running": "In corso",
    "paused": "In pausa",
    "done": "Conclusi",
    "settings": "Impostazioni",
    "providers": "Provider",
    "glossaries": "Glossari",
    "translation": "Traduzione",
    "application": "Applicazione"
  },
```

e in `en.json`: `Projects`, `To approve`, `Running`, `Paused`, `Finished`,
`Settings`, `Providers`, `Glossaries`, `Translation`, `Application`.

Dalla libreria togli il collegamento alle impostazioni nell'intestazione: è
nella colonna, e averlo in due posti a dieci centimetri è il disordine che
questo lavoro toglie. «Nuovo progetto» resta dov'è, primario sopra la griglia.

- [ ] **Step 4: Lancialo e guardalo passare**

Da `app/`: `npx ng test`. Attesa: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/app.html app/renderer/src/app/app.ts app/renderer/src/app/app.css app/renderer/src/app/app.spec.ts app/renderer/src/app/library app/locales
git commit -m "feat(ui): la colonna che non se ne va, e il ritorno indietro che smette di poter mancare"
```

---

### Task 4: La striscia di schede dentro Impostazioni sparisce

La colonna elenca già le quattro sezioni. Ripeterle a dieci centimetri è la stessa navigazione due volte.

**Files:**
- Modify: `app/renderer/src/app/settings/settings.html`, `settings.css`
- Modify: `app/renderer/src/app/settings/settings.spec.ts`
- Modify: `app/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: l'input `section` (Task 2), la colonna (Task 3)
- Produces: nessuna interfaccia

- [ ] **Step 1: Aggiorna i test che descrivono le schede**

In `settings.spec.ts` e in `app/e2e/settings.spec.ts`, i test che cliccano
`.settings__section` per cambiare sezione ora navigano: sostituisci il clic
sulla scheda con una navigazione a `/settings/<section>` — nella spec di
componente con `setInput("section", …)`, nell'e2e con un clic sulla voce
`[data-testid=nav-glossaries]` della colonna.

- [ ] **Step 2: Lanciali e guardali fallire**

Da `app/`: `npx ng test`. Attesa: FAIL, perché la colonna non è nel montaggio
della spec di Settings — che è il segno che la navigazione è passata al guscio.

- [ ] **Step 3: Togli la striscia**

Da `settings.html` elimina il blocco `.settings__sections` con il suo `@for`.
Da `settings.css` elimina le regole `.settings__sections`, `.settings__section`,
`.settings__section--on` e il loro `:hover`. Il componente conserva l'input
`section` e mostra il pannello corrispondente.

- [ ] **Step 4: Lanciali e guardali passare**

Da `app/`:

```bash
npx ng test
npm run build && xvfb-run --auto-servernum npx playwright test e2e/settings.spec.ts
```

Attesa: PASS in entrambi.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/settings app/e2e/settings.spec.ts
git commit -m "feat(ui): le sezioni si scelgono nella colonna, non due volte"
```

---

### Task 5: Eliminare un progetto

Tutto il retro esiste già e non ha mai avuto un chiamante.

**Files:**
- Modify: `app/renderer/src/app/library/library.html`, `library.ts`
- Modify: `app/renderer/src/app/library/library.spec.ts`
- Modify: `app/locales/en.json`, `app/locales/it.json`

**Interfaces:**
- Consumes: `ui.confirm` con kind `deleteProject`, `project.delete` — entrambi esistenti
- Produces: `Library.remove(project: ProjectSummary): Promise<void>`

- [ ] **Step 1: Scrivi i test che falliscono**

In `library.spec.ts`:

```typescript
it("asks before deleting, naming the book", async () => {
  const { fixture, invoke } = mount({ "projects.list": [summary], "ui.confirm": { confirmed: true } });
  await fixture.whenStable();
  fixture.detectChanges();

  fixture.nativeElement.querySelector("[data-testid=delete-p1]").click();
  await fixture.whenStable();

  expect(calls(invoke, "ui.confirm")[0]![1]).toMatchObject({
    kind: "deleteProject", detail: { title: summary.title },
  });
  expect(calls(invoke, "project.delete")).toHaveLength(1);
});

it("deletes nothing when the answer is no", async () => {
  const { fixture, invoke } = mount({ "projects.list": [summary], "ui.confirm": { confirmed: false } });
  await fixture.whenStable();
  fixture.detectChanges();

  fixture.nativeElement.querySelector("[data-testid=delete-p1]").click();
  await fixture.whenStable();

  // A refusal is an answer, and an answer that destroys nothing.
  expect(calls(invoke, "project.delete")).toHaveLength(0);
});
```

- [ ] **Step 2: Lanciali e guardali fallire**

Da `app/`: `npx ng test`. Attesa: FAIL — nessun `delete-p1` nel DOM.

- [ ] **Step 3: Aggiungi l'azione**

In `library.ts`:

```typescript
  /**
   * Deleting asks first, and the question names the book.
   *
   * The main process assembles the sentence and the platform draws the box;
   * the window only says which act it is about to perform.
   */
  async remove(project: ProjectSummary): Promise<void> {
    const { confirmed } = await this.#ipc.invoke("ui.confirm", {
      kind: "deleteProject", detail: { title: project.title },
    });
    if (!confirmed) return;

    await this.#ipc.invoke("project.delete", { id: project.id });
    await this.reload();
  }
```

In `library.html`, sulla card del progetto:

```html
<button type="button" class="btn btn-sm btn-error"
        [attr.data-testid]="'delete-' + project.id"
        (click)="remove(project)">
  {{ t('library.delete') }}
</button>
```

Le stringhe: `library.delete` = «Elimina» / «Delete».

- [ ] **Step 4: Lanciali e guardali passare**

Da `app/`: `npx ng test`. Attesa: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/library app/locales
git commit -m "feat(library): un progetto si elimina, dopo aver chiesto e nominandolo"
```

---

### Task 6: Esportare il libro tradotto

Non si dovrebbe dover eliminare un progetto per salvarne il risultato.

**Files:**
- Modify: `app/main/main.ts:362` (`chooseSave`)
- Modify: `app/shared/channels.ts`
- Modify: `app/main/ipc.ts`
- Modify: `app/renderer/src/app/project/report/report.html`, `report.ts`
- Modify: `app/renderer/src/app/project/report/report.spec.ts`
- Modify: `app/locales/en.json`, `app/locales/it.json`

**Interfaces:**
- Consumes: `outputPath` di `ProjectDetail`, già presente
- Produces:
  - `chooseSave(defaultName: string, kind: "glossary" | "epub"): Promise<string | null>`
  - canale `project.export`: `{ req: { id: string; to: string }; res: void }`

- [ ] **Step 1: Scrivi il test che fallisce**

In `report.spec.ts`:

```typescript
it("saves the translated book where it is asked to, and leaves the project alone", async () => {
  const { fixture, invoke } = render(base, { "ui.chooseSave": "/home/somebody/book.it.epub" });
  await fixture.whenStable();
  fixture.detectChanges();

  fixture.nativeElement.querySelector("[data-testid=export-epub]").click();
  await fixture.whenStable();

  expect(calls(invoke, "project.export")[0]![1]).toMatchObject({ to: "/home/somebody/book.it.epub" });
  // Exporting is not a branch of deleting: nothing is destroyed by saving.
  expect(calls(invoke, "project.delete")).toHaveLength(0);
});
```

- [ ] **Step 2: Lancialo e guardalo fallire**

Da `app/`: `npx ng test`. Attesa: FAIL — nessun `export-epub`.

- [ ] **Step 3: Insegna a `chooseSave` gli EPUB, e aggiungi il canale**

In `app/main/main.ts`, `chooseSave` prende il tipo di file:

```typescript
    chooseSave: async (defaultName, kind) => {
      const chosen = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: kind === "epub"
          ? [{ name: "EPUB", extensions: ["epub"] }]
          : [{ name: "Glossary", extensions: ["md"] }],
      });
      return chosen.canceled || chosen.filePath === undefined ? null : chosen.filePath;
    },
```

Aggiorna la firma in `app/main/ipc.ts` (`IpcDeps.chooseSave`) e il chiamante
esistente dei glossari, che passa `"glossary"`.

Il canale nuovo in `app/shared/channels.ts`:

```typescript
  "project.export": { req: { id: string; to: string }; res: void };
```

e il suo handler in `app/main/ipc.ts`, che copia l'unico file prodotto:

```typescript
    "project.export": async ({ id, to }) => {
      // The same copy `deleteWorkspace` would make on its way out, offered at
      // the moment someone actually wants it rather than as a side effect of
      // destroying the project around it.
      const workspace = workspaceOf(deps.db, id);
      const produced = await readdir(workspace.outputDir);
      if (produced[0] === undefined) throw new Error("NOTHING_TO_EXPORT");
      await copyFile(join(workspace.outputDir, produced[0]), to);
    },
```

In `report.ts`:

```typescript
  async exportEpub(): Promise<void> {
    const to = await this.#ipc.invoke("ui.chooseSave", {
      defaultName: this.suggestedName(), kind: "epub",
    });
    if (to === null) return;
    await this.#ipc.invoke("project.export", { id: this.projectId(), to });
  }
```

e in `report.html`, accanto ad `open-epub` e `reveal-epub`:

```html
<button type="button" class="btn btn-sm" data-testid="export-epub" (click)="exportEpub()">
  {{ t('report.exportEpub') }}
</button>
```

Le stringhe: `report.exportEpub` = «Esporta il libro tradotto» / «Export the
translated book».

- [ ] **Step 4: Lancialo e guardalo passare**

```bash
npx vitest run app/test/ipc.test.ts && cd app && npx ng test
```

Attesa: PASS in entrambi.

- [ ] **Step 5: Commit**

```bash
git add app/main app/shared/channels.ts app/renderer/src/app/project/report app/locales
git commit -m "feat(project): il libro tradotto si esporta, senza eliminare il progetto attorno"
```

---

### Task 7: Tutto insieme, e le schermate

**Files:**
- Modify: `app/e2e/screens.spec.ts` (le nuove rotte)
- Modify: `app/e2e/screenshots/*`

**Interfaces:**
- Consumes: tutti i task precedenti
- Produces: niente

- [ ] **Step 1: Aggiorna i cammini dell'e2e**

`screens.spec.ts` naviga per rotta: `/` diventa `/projects/all`, `/settings`
diventa `/settings/providers`, e le tre sezioni si raggiungono dalla colonna.
Aggiungi due schermate nuove — `library-to-approve` in chiaro e scuro — perché
il gruppo che giustifica la quinta voce merita di essere guardato.

- [ ] **Step 2: La suite intera**

Dalla radice:

```bash
npm run typecheck && npm test -w core && npm test -w app
```

Da `app/`:

```bash
xvfb-run --auto-servernum npm run test:e2e
```

Attesa: tutto verde; 12 passati e 1 saltato nell'e2e.

- [ ] **Step 3: Guarda le schermate**

Apri tutte le immagini di `app/e2e/screenshots/`. Tre cose da cercare:

1. **La colonna c'è su ogni schermata**, «Nuovo progetto» compresa. È l'intero
   punto del piano.
2. **I numeri accanto alle voci** corrispondono ai progetti visibili.
3. **Le impostazioni non hanno più due navigazioni**, una nella colonna e una
   sopra il pannello.

- [ ] **Step 4: Commit**

```bash
git add app/e2e
git commit -m "test(e2e): le schermate dentro il guscio, in entrambi i temi"
```
