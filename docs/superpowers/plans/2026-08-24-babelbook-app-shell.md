# babelBook — Piano 3: shell Electron, database e creazione progetto

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un'applicazione che si apre, mostra la libreria dei progetti, e sa creare un progetto da un EPUB: copia, analisi locale, unità in database, copertina sullo schermo.

**Architecture:** tre processi. Il **main** possiede il database (`node:sqlite`) e le chiavi; il **preload** espone una superficie tipizzata e nient'altro; il **renderer** è Angular e non vede Node. La creazione di un progetto è tutta deterministica e locale: nessuna chiamata di rete, quindi nessun provider necessario per cominciare.

**Tech Stack:** Electron 43 (Node 24.18.1), `node:sqlite`, Angular 22, Transloco, esbuild per main/preload, vitest per main e core, Playwright per una prova end-to-end.

**Spec:** `docs/superpowers/specs/2026-08-24-babelbook-design.md`
**Piani precedenti:** `2026-08-24-babelbook-core-epub.md` (obbligatorio), `2026-08-24-babelbook-core-translate.md` (serve solo il tipo `ProjectStore`)

## Global Constraints

- **Node 24.18.x** nelle shell non interattive:
  `export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`
- **ESM ovunque**, import con estensione `.ts` in `core/`; in `app/` il bundle lo produce esbuild, quindi lì valgono le estensioni che TypeScript risolve normalmente.
- **`core/` resta puro**: il test di confine dei piani 1 e 2 continua a girare e non va indebolito. Il database vive solo in `app/main/`.
- **`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.** Il renderer non costruisce percorsi di file e non apre nulla: chiede al main.
- **Codice e commenti in inglese**, documenti in italiano, **interfaccia localizzabile**: nessuna stringa rivolta all'utente scritta a mano nei componenti, tutte nei cataloghi.
- **Test:** `npm test` alla radice esegue core e main.
- **Commit a ogni task.**

## Struttura dei file

```
app/
  package.json               name: @babelbook/app
  esbuild.mjs                bundle di main, preload, engine
  main/
    main.ts                  ciclo di vita, finestra, protocollo app://
    window.ts                creazione della BrowserWindow
    db/open.ts               apertura di node:sqlite, WAL, pragma
    db/migrate.ts            esecutore delle migrazioni
    db/migrations/001-initial.sql
    db/store.ts              SqliteProjectStore: implementa ProjectStore
    projects/create.ts       ingestione di un EPUB in un progetto
    projects/query.ts        letture per la libreria
    workspace.ts             cartelle, copia del sorgente, copertina
    ipc.ts                   registrazione dei canali
  preload/preload.ts         contextBridge tipizzato
  shared/channels.ts         i nomi e i tipi dei canali, condivisi
  renderer/                  progetto Angular 22
    src/app/...
  locales/it.json, en.json
  test/                      test del main, con vitest
```

---

### Task 1: L'applicazione si apre

**Files:**
- Create: `app/package.json`, `app/esbuild.mjs`, `app/main/main.ts`, `app/main/window.ts`, `app/preload/preload.ts`, `app/renderer/` (progetto Angular), `app/test/smoke.test.ts`
- Modify: `package.json` (radice: aggiungere `app` ai workspaces, e portare gli script a
  `"test": "npm test -w core && npm test -w app"` e
  `"typecheck": "npm run typecheck -w core && npm run typecheck -w app"`)
- Create: `vitest.config.ts` (radice)

**Interfaces:**
- Produces: `npm start` apre una finestra che mostra l'applicazione Angular; `npm run build -w app` produce i bundle.

**Tre cose verificate eseguendo questo task, non dedotte:**

- **Angular 22 richiede TypeScript 6.** `@angular/compiler-cli@22` dichiara `typescript >=6.0 <6.1`; `core` resta sul 5.x e npm annida le due versioni senza conflitto.
- **`zone.js` non serve.** Angular 22 è zoneless di default e lo dichiara come peer opzionale.
- **La build serve al test, quindi la fa il test.** Il primo test asserisce su `app/dist/`: senza costruire, passa sulla macchina di chi ha appena compilato e fallisce su un clone fresco, che è il verso sbagliato. La build di un'app segnaposto con il builder esbuild costa meno di un secondo, quindi farla in `beforeAll` non pesa.

- [ ] **Step 1: Scrivere il test che fallisce**

`app/test/smoke.test.ts`:

```ts
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("build output", () => {
  beforeAll(async () => {
    await run("npm", ["run", "build", "-w", "app"], { cwd: process.cwd() });
  }, 300_000);

  it("produces the three bundles the app needs", () => {
    expect(existsSync("app/dist/main/main.js")).toBe(true);
    expect(existsSync("app/dist/preload/preload.js")).toBe(true);
    expect(existsSync("app/dist/renderer/index.html")).toBe(true);
  });
});
```

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
npx vitest run app/test/smoke.test.ts
```
Atteso: FAIL, i tre file non esistono.

- [ ] **Step 3: Creare il pacchetto e i bundle**

`app/package.json`:

```json
{
  "name": "@babelbook/app",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main/main.js",
  "scripts": {
    "build": "node esbuild.mjs && ng build --configuration production",
    "start": "npm run build && electron .",
    "test": "vitest run"
  },
  "dependencies": { "@babelbook/core": "*" },
  "devDependencies": {
    "@angular/build": "^22.1.0",
    "@angular/cli": "^22.1.0",
    "@angular/common": "^22.1.0",
    "@angular/core": "^22.1.0",
    "@angular/forms": "^22.1.0",
    "@angular/platform-browser": "^22.1.0",
    "@angular/router": "^22.1.0",
    "@jsverse/transloco": "^8.0.0",
    "electron": "^43.4.1",
    "esbuild": "^0.25.0",
    "rxjs": "^7.8.0",
    "typescript": "^6.0.0",
    "vitest": "^4.1.10"
  }
}
```

Serve anche un `vitest.config.ts` alla radice che escluda `.claude/**`, `.worktrees/**` e `.angular/**`: i worktree vivono dentro il repository, quindi un filtro come `vitest run app/test` combacia anche con `.claude/worktrees/<agente>/app/test` ed esegue la suite di un altro ramo insieme alla propria.

`app/esbuild.mjs` produce due bundle con `platform: "node"`, `format: "esm"`, `external: ["electron"]`: `main/main.ts` in `dist/main/main.js` e `preload/preload.ts` in `dist/preload/preload.js`. Il preload va emesso in **CommonJS** (`format: "cjs"`, estensione `.js`): con `sandbox: true` Electron carica lo script di preload come CommonJS, e un bundle ESM lì fallisce silenziosamente a finestra già aperta.

Il progetto Angular si genera con `npx ng new renderer --standalone --routing --style=css --skip-git` dentro `app/`, poi si imposta in `angular.json` l'output in `dist/renderer` e `"baseHref": "./"`.

`app/main/window.ts` crea la finestra con `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` e il preload compilato.

**Il renderer non si carica da `file://`.** Si registra uno schema privilegiato `app` e lo si serve con `protocol.handle("app", …)` leggendo da `dist/renderer`: con `file://` il router Angular e le richieste relative si rompono in modi che sembrano bug dell'applicazione, e la CSP diventa impossibile da stringere. In sviluppo, se `VITE_DEV_SERVER` o `NG_DEV_SERVER` è impostata, si carica quell'URL.

- [ ] **Step 4: Costruire ed eseguire il test**

```bash
npm install
npm run build -w app
npx vitest run app/test/smoke.test.ts
```
Atteso: PASS.

- [ ] **Step 5: Provare l'applicazione a mano**

```bash
npm start -w app
```
Atteso: si apre una finestra con la pagina Angular predefinita. Chiuderla.

- [ ] **Step 6: Commit**

```bash
git add app package.json package-lock.json
git commit -m "feat(app): an Electron shell that serves Angular over its own protocol"
```

---

### Task 2: Apertura del database e migrazioni

**Files:**
- Create: `app/main/db/open.ts`, `app/main/db/migrate.ts`, `app/main/db/migrations/001-initial.sql`, `app/test/migrate.test.ts`

**Interfaces:**
- Produces:

```ts
export function openDatabase(path: string): DatabaseSync;   // ":memory:" ammesso
export interface Migration { id: string; sql: string }
export function loadMigrations(dir: string): Migration[];
export function migrate(db: DatabaseSync, migrations: Migration[]): { applied: string[] };
export function currentVersion(db: DatabaseSync): string | null;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/migrate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../main/db/open.ts";

const m = (id: string, sql: string) => ({ id, sql });

describe("migrate", () => {
  it("applies migrations in id order and records them", () => {
    const db = openDatabase(":memory:");
    const applied = migrate(db, [
      m("002-second", "CREATE TABLE b (id TEXT);"),
      m("001-first", "CREATE TABLE a (id TEXT);"),
    ]);
    expect(applied.applied).toEqual(["001-first", "002-second"]);
  });

  it("is idempotent: running twice applies nothing new", () => {
    const db = openDatabase(":memory:");
    const ms = [m("001-first", "CREATE TABLE a (id TEXT);")];
    migrate(db, ms);
    expect(migrate(db, ms).applied).toEqual([]);
  });

  it("leaves the database untouched when a migration fails", () => {
    const db = openDatabase(":memory:");
    expect(() => migrate(db, [
      m("001-first", "CREATE TABLE a (id TEXT);"),
      m("002-bad", "CREATE TABLE ;;;"),
    ])).toThrow();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).not.toContain("a");
  });

  it("turns on WAL and foreign keys", () => {
    const db = openDatabase(":memory:");
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/migrate.test.ts`
Atteso: FAIL, `Cannot find module '../main/db/open.ts'`.

- [ ] **Step 3: Implementare**

`openDatabase` usa `DatabaseSync` da `node:sqlite`, e imposta `PRAGMA journal_mode = WAL` (silenziosamente ignorato in memoria) e `PRAGMA foreign_keys = ON` — **le chiavi esterne in SQLite sono spente di default**, e uno schema che le dichiara senza accenderle non le fa rispettare.

`migrate` **avvolge tutte le migrazioni in una sola transazione**: metà schema applicato è lo stato peggiore, perché al riavvio l'applicazione trova un database che sembra a posto e non lo è. Registra ciò che ha applicato in una tabella `schema_migration(id TEXT PRIMARY KEY, applied_at TEXT)`.

L'ordine è quello degli id, che iniziano con un numero: l'ordine del filesystem non è garantito.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/migrate.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add app/main/db app/test/migrate.test.ts
git commit -m "feat(db): migrations in one transaction, foreign keys actually on"
```

---

### Task 3: Lo schema iniziale

**Files:**
- Create (contenuto): `app/main/db/migrations/001-initial.sql`
- Create: `app/test/schema.test.ts`

**Interfaces:**
- Produces: le tabelle della spec.

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";

function migrated() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  return db;
}

describe("schema", () => {
  it("has every table the design names", () => {
    const names = (migrated().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((t) => t.name);
    for (const t of [
      "project", "project_document", "unit", "translation", "term",
      "glossary", "glossary_term", "project_glossary",
      "provider", "provider_model", "run", "run_event", "setting",
    ]) expect(names).toContain(t);
  });

  it("refuses a unit whose project does not exist", () => {
    const db = migrated();
    expect(() => db.prepare(
      "INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, range_start, range_end, state, source_text) "
      + "VALUES ('u1', 'ghost', 'd1', 1, 'c1#1', 0, 1, 'translate', 'x')",
    ).run()).toThrow();
  });

  it("keeps one translation per unit and cache key", () => {
    const db = migrated();
    db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
      + "VALUES ('p1','b.epub','Book','/w','h','2026-08-24','it','ready')").run();
    db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
    db.prepare("INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, range_start, range_end, state, source_text) "
      + "VALUES ('u1','p1','d1',1,'c1.xhtml#1',0,5,'translate','One')").run();
    const ins = "INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome) VALUES (?,?,?,?,?,?)";
    db.prepare(ins).run("t1", "u1", "Uno", "k1", 1, "translated");
    expect(() => db.prepare(ins).run("t2", "u1", "Uno bis", "k1", 1, "translated")).toThrow();
    db.prepare(ins).run("t3", "u1", "Uno ter", "k2", 1, "translated");
  });

  it("deletes a project's rows with the project", () => {
    const db = migrated();
    db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
      + "VALUES ('p1','b.epub','Book','/w','h','2026-08-24','it','ready')").run();
    db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
    db.prepare("DELETE FROM project WHERE id = 'p1'").run();
    expect((db.prepare("SELECT count(*) AS n FROM project_document").get() as { n: number }).n).toBe(0);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/schema.test.ts`
Atteso: FAIL, le tabelle non esistono.

- [ ] **Step 3: Scrivere la migrazione**

`001-initial.sql` crea le tredici tabelle della spec, con:

- `ON DELETE CASCADE` da `project` verso `project_document`, `unit`, `term`, `project_glossary`, `run`; da `unit` verso `translation`; da `run` verso `run_event`;
- `UNIQUE(unit_id, cache_key)` su `translation` — è ciò che rende la cache una cache invece di un registro che cresce;
- `UNIQUE(project_id, unit_id)` su `unit`;
- `project.layout` e `project_document.layout` con `CHECK (layout IN ('reflowable','pre-paginated','mixed'))`;
- `unit.state` con `CHECK` sull'elenco degli stati del piano 1, più `forced_state` e `forced_by` per il gate delle esclusioni;
- `project.machine_snapshot` come TEXT (JSON), e `project.state` denormalizzato per i filtri della libreria — **la verità è lo snapshot**, e `state` si riscrive a ogni transizione accettata;
- indici su `unit(project_id, state)` e `translation(cache_key)`: sono le due query che la libreria e il motore fanno di continuo.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/schema.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add app/main/db/migrations app/test/schema.test.ts
git commit -m "feat(db): the initial schema, with the cascades and the cache uniqueness"
```

---

### Task 4: `ProjectStore` su SQLite, verificato dallo stesso contratto del finto

**Files:**
- Create: `app/main/db/store.ts`, `app/test/store-contract.test.ts`
- Create: `core/test/contract/project-store.ts` (la batteria condivisa)
- Modify: `core/test/ports.test.ts` (usa la batteria)

**Interfaces:**
- Consumes: `ProjectStore` (piano 2)
- Produces: `class SqliteProjectStore implements ProjectStore`, costruito su un `DatabaseSync` e un `projectId`.

- [ ] **Step 1: Estrarre la batteria di contratto**

`core/test/contract/project-store.ts` esporta `runProjectStoreContract(name: string, make: () => Promise<ProjectStore>)`, che registra con `describe(name, …)` i test che ogni implementazione deve superare: scrivere e rileggere una traduzione sotto la sua chiave, non vederla sotto un'altra chiave, sostituire una traduzione esistente per la stessa coppia unità-chiave, filtrare le unità per stato, cambiare lo stato di un'unità, registrare un evento, salvare e rileggere i termini.

**Perché una batteria condivisa.** Il finto e l'implementazione vera devono essere intercambiabili, altrimenti i test del piano 2 dimostrano qualcosa su un oggetto che non è quello che gira in produzione. Un solo file di test, due esecuzioni.

- [ ] **Step 2: Scrivere il test che fallisce**

`app/test/store-contract.test.ts`:

```ts
import { runProjectStoreContract } from "../../core/test/contract/project-store.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { SqliteProjectStore } from "../main/db/store.ts";

runProjectStoreContract("SqliteProjectStore", async () => {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
    + "VALUES ('p1','b.epub','Book','/w','h','2026-08-24','it','ready')").run();
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
  return new SqliteProjectStore(db, "p1");
});
```

E in `core/test/ports.test.ts`, la stessa batteria contro `FakeStore`.

- [ ] **Step 3: Eseguirlo e verificare che fallisca**

Run: `npx vitest run app/test/store-contract.test.ts`
Atteso: FAIL, `Cannot find module '../main/db/store.ts'`.

- [ ] **Step 4: Implementare**

`SqliteProjectStore` prepara le istruzioni una volta sola nel costruttore. `putTranslation` fa `INSERT … ON CONFLICT(unit_id, cache_key) DO UPDATE`: una traduzione riprovata sostituisce la precedente invece di accumularsi.

Le scritture di un gruppo passano da una transazione: il motore conferma unità per unità, ma una pausa nel mezzo non deve lasciare metà gruppo scritto con l'evento dell'altra metà mancante.

- [ ] **Step 5: Eseguire entrambe le esecuzioni della batteria**

```bash
npx vitest run app/test/store-contract.test.ts core/test/ports.test.ts
```
Atteso: PASS, la stessa lista di test due volte.

- [ ] **Step 6: Commit**

```bash
git add app/main/db/store.ts app/test/store-contract.test.ts core/test/contract core/test/ports.test.ts
git commit -m "feat(db): one contract, two implementations, no divergence"
```

---

### Task 5: Il workspace del progetto

**Files:**
- Create: `app/main/workspace.ts`, `app/test/workspace.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Workspace { root: string; source: string; outputDir: string; coverPath?: string }
export function createWorkspace(base: string, projectId: string): Promise<Workspace>;
export function copySource(ws: Workspace, epubPath: string): Promise<{ sha256: string; bytes: number }>;
export function extractCover(ws: Workspace, entries: ZipEntry[], pkg: PackageDoc): Promise<string | null>;
export function deleteWorkspace(ws: Workspace, opts: { keepOutput?: string }): Promise<void>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/workspace.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { readEpub, readPackage } from "../../core/epub/index.ts";
import { copySource, createWorkspace, deleteWorkspace, extractCover } from "../main/workspace.ts";

async function base() { return mkdtemp(join(tmpdir(), "babelbook-")); }

describe("workspace", () => {
  it("creates the folders a project needs", async () => {
    const ws = await createWorkspace(await base(), "p1");
    expect(existsSync(ws.root)).toBe(true);
    expect(existsSync(ws.outputDir)).toBe(true);
  });

  it("copies the source and hashes what it copied, not what it read", async () => {
    const dir = await base();
    const epub = join(dir, "book.epub");
    await writeFile(epub, await buildEpub({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] }));
    const ws = await createWorkspace(dir, "p1");
    const { sha256 } = await copySource(ws, epub);
    const copied = await readFile(ws.source);
    expect(copied).toEqual(await readFile(epub));
    expect(sha256).toHaveLength(64);
  });

  it("extracts the cover the package declares", async () => {
    const dir = await base();
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }],
      extra: [{ path: "OEBPS/cover.png", bytes: Buffer.from("89504e470d0a1a0a", "hex") }],
      manifestExtra: `<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>`,
    });
    const ws = await createWorkspace(dir, "p1");
    const epub = await readEpub(bytes);
    const cover = await extractCover(ws, epub.entries, readPackage(epub.entries));
    expect(cover).not.toBeNull();
    expect(existsSync(cover!)).toBe(true);
  });

  it("deletes the workspace but can keep the translated book", async () => {
    const dir = await base();
    const ws = await createWorkspace(dir, "p1");
    await writeFile(join(ws.outputDir, "book.it.epub"), "x");
    const keep = join(dir, "kept.epub");
    await deleteWorkspace(ws, { keepOutput: keep });
    expect(existsSync(ws.root)).toBe(false);
    expect(existsSync(keep)).toBe(true);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/workspace.test.ts`
Atteso: FAIL, `Cannot find module '../main/workspace.ts'`.

- [ ] **Step 3: Implementare**

1. Il workspace è `<base>/projects/<projectId>/` con dentro `source.epub`, `output/`, ed eventualmente `cover.<ext>` ed `export/`. **Nessuno stato**: se sparisce, il progetto resta visibile in database e dichiara che il sorgente manca.
2. `copySource` calcola l'hash **sui byte copiati**, non su quelli letti: è la copia che verrà tradotta, ed è di quella che l'hash deve parlare.
3. La copertina si cerca in tre modi, in ordine: la proprietà `cover-image` nel manifest, il vecchio `<meta name="cover">` degli EPUB 2, e infine la prima immagine referenziata dal primo documento della spine. Se non si trova, `null` — l'interfaccia mostra un segnaposto, non un errore.
4. `deleteWorkspace` cancella l'albero, ma se `keepOutput` è dato copia prima l'EPUB tradotto fuori. Cancellare il lavoro pagato insieme al progetto è il tipo di sorpresa che non si perdona.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/workspace.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add app/main/workspace.ts app/test/workspace.test.ts
git commit -m "feat(app): a workspace that holds artefacts and no state"
```

---

### Task 6: Ingestione di un EPUB in un progetto

**Files:**
- Create: `app/main/projects/create.ts`, `app/main/projects/query.ts`, `app/test/create.test.ts`

**Interfaces:**
- Consumes: piano 1 per intero, `createWorkspace` (Task 5), il database (Task 3)
- Produces:

```ts
export interface CreateInput {
  epubPath: string;
  targetLanguage: string;
  sourceLanguage?: string;
  description?: string;
  providerId?: string;
  modelId?: string;
}
export interface CreatedProject {
  id: string;
  title: string;
  author?: string;
  coverPath: string | null;
  declaredLanguage: string | null;
  documents: number;
  units: { total: number; work: number; byState: Record<string, number> };
  words: number;
  layout: LayoutReport;
  hasOverlays: boolean;
}
export function createProject(db: DatabaseSync, base: string, input: CreateInput): Promise<CreatedProject>;
export class UnsupportedFormatError extends Error { code: "UNSUPPORTED_FORMAT"; format: string }
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/create.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { createProject } from "../main/projects/create.ts";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-"));
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  return { dir, db };
}

async function epubAt(dir: string, name: string, spec: Parameters<typeof buildEpub>[0]) {
  const path = join(dir, name);
  await writeFile(path, await buildEpub(spec));
  return path;
}

describe("createProject", () => {
  it("stores the project, its documents and its units", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      title: "The Book", language: "en",
      documents: [
        { path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><pre>x = 1</pre>" },
        { path: "OEBPS/c2.xhtml", xhtml: "<p>Two</p>" },
      ],
    });
    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it" });

    expect(created.title).toBe("The Book");
    expect(created.declaredLanguage).toBe("en");
    expect(created.units.byState.code).toBe(1);
    const rows = db.prepare("SELECT count(*) AS n FROM unit WHERE project_id = ?").get(created.id) as { n: number };
    expect(rows.n).toBe(created.units.total);
  });

  it("refuses a file that is not an EPUB, naming the format", async () => {
    const { dir, db } = await setup();
    const notEpub = join(dir, "book.mobi");
    await writeFile(notEpub, "BOOKMOBI garbage");
    await expect(createProject(db, dir, { epubPath: notEpub, targetLanguage: "it" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", format: "MOBI" });
  });

  it("reports fixed layout instead of silently translating it", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "comic.epub", {
      documents: [{ path: "OEBPS/p1.xhtml", xhtml: "<p>Plate</p>", layout: "pre-paginated" }],
    });
    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it" });
    expect(created.layout.prePaginated).toBeGreaterThan(0);
  });

  it("reports media overlays at creation, before anything is spent", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "audio.epub", {
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi</p>` }],
      overlays: [{ smilPath: "OEBPS/c1.smil", audioPath: "OEBPS/c1.mp3", forDocument: "OEBPS/c1.xhtml", duration: "0:00:05" }],
    });
    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it" });
    expect(created.hasOverlays).toBe(true);
  });

  it("leaves nothing behind when ingestion fails halfway", async () => {
    const { dir, db } = await setup();
    const broken = join(dir, "broken.epub");
    await writeFile(broken, "PK not really a zip");
    await expect(createProject(db, dir, { epubPath: broken, targetLanguage: "it" })).rejects.toThrow();
    expect((db.prepare("SELECT count(*) AS n FROM project").get() as { n: number }).n).toBe(0);
  });

  it("does not call any model: a project can be created with no provider", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", { documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }] });
    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it" });
    expect(created.id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/create.test.ts`
Atteso: FAIL, `Cannot find module '../main/projects/create.ts'`.

- [ ] **Step 3: Implementare**

L'ordine è quello della spec, e non chiama mai un modello:

1. **Preflight sul formato.** Si guardano i primi byte: la firma di uno zip più una entry `mimetype` che dice `application/epub+zip` è un EPUB. La firma `BOOKMOBI` è un MOBI, gli header Kindle sono AZW o KFX. Un formato riconosciuto e non supportato diventa `UnsupportedFormatError` **che lo nomina**: "non è un EPUB" non aiuta nessuno, "questo è un MOBI, babelBook tratta solo EPUB" sì.
2. Creazione del workspace, copia, hash.
3. `readEpub`, `readPackage`, `detectLayout`, `hasOverlays`, `archiveCodeSurfaces`.
4. Per ogni documento XHTML della spine più il nav: `assertUtf8`, `extract` con le superfici di codice, e scrittura delle unità.
5. Estrazione della copertina.
6. Conteggio delle parole sulle unità di lavoro, che serve alla stima di costo.

**Tutta la scrittura in una transazione**, e in caso di errore si cancella anche il workspace: un progetto a metà nel database è peggio di nessun progetto, perché l'interfaccia lo mostra e non funziona.

Lo stato iniziale è `ready` se la lingua è decisa, altrimenti `needs-language`.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/create.test.ts`
Atteso: PASS, sei test.

- [ ] **Step 5: Commit**

```bash
git add app/main/projects app/test/create.test.ts
git commit -m "feat(app): ingest a book locally, and refuse other formats by name"
```

---

### Task 7: La superficie IPC

**Files:**
- Create: `app/shared/channels.ts`, `app/main/ipc.ts`, `app/preload/preload.ts` (riscrittura), `app/test/ipc.test.ts`

**Interfaces:**
- Produces:

```ts
// app/shared/channels.ts — l'unico posto dove i canali sono definiti
export interface Invocations {
  "projects.list": { req: { filter?: string }; res: ProjectSummary[] };
  "project.get": { req: { id: string }; res: ProjectDetail };
  "project.create": { req: CreateInput; res: CreatedProject };
  "project.delete": { req: { id: string; keepOutput?: string }; res: void };
  "project.chooseEpub": { req: void; res: { path: string; name: string } | null };
  "settings.get": { req: void; res: Settings };
  "settings.set": { req: Partial<Settings>; res: Settings };
}
export interface Events {
  "project.changed": { id: string };
  "run.phase": { projectId: string; phase: string };
  "run.progress": { projectId: string; done: number; total: number };
}
export const INVOCATIONS: Array<keyof Invocations>;
export const EVENTS: Array<keyof Events>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/ipc.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { INVOCATIONS, EVENTS } from "../shared/channels.ts";

describe("ipc surface", () => {
  it("registers a handler for every declared invocation", async () => {
    const source = await readFile("app/main/ipc.ts", "utf8");
    for (const channel of INVOCATIONS) expect(source).toContain(`"${channel}"`);
  });

  it("exposes the bridge without handing the renderer anything else", async () => {
    const source = await readFile("app/preload/preload.ts", "utf8");
    expect(source).toContain("contextBridge.exposeInMainWorld");
    expect(source).toContain("INVOCATIONS");
    expect(source).toContain("EVENTS");
    expect(source).not.toContain("node:fs");
  });

  it("keeps the renderer away from Node entirely", async () => {
    const source = await readFile("app/main/window.ts", "utf8");
    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("nodeIntegration: false");
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/ipc.test.ts`
Atteso: FAIL, `Cannot find module '../shared/channels.ts'`.

- [ ] **Step 3: Implementare**

`channels.ts` è **l'unico posto** dove un canale è definito, e main, preload e renderer lo importano tutti e tre: un canale aggiunto in un punto solo smette di compilare negli altri due, che è esattamente ciò che serve.

Il preload espone due sole forme, costruite ciclando su `INVOCATIONS` ed `EVENTS`:

```ts
contextBridge.exposeInMainWorld("babelbook", {
  invoke: (channel, payload) => {
    if (!INVOCATIONS.includes(channel)) throw new Error(`unknown channel: ${channel}`);
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, listener) => {
    if (!EVENTS.includes(channel)) throw new Error(`unknown event: ${channel}`);
    const wrapped = (_e, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.off(channel, wrapped);
  },
});
```

Il controllo sull'elenco non è cerimonia: senza, il renderer può invocare qualunque canale che il main abbia registrato per altri scopi.

**Nessun percorso di file arriva al main senza che sia il main ad averlo prodotto.** `project.create` riceve il percorso scelto da `project.chooseEpub`, che passa da `dialog.showOpenDialog`: è il main a sapere quali file esistono, non la finestra a dichiararlo.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/ipc.test.ts`
Atteso: PASS, tre test.

- [ ] **Step 5: Commit**

```bash
git add app/shared app/main/ipc.ts app/preload/preload.ts app/test/ipc.test.ts
git commit -m "feat(app): one place where channels are declared, three that must agree"
```

---

### Task 8: Il renderer parla, e parla tradotto

**Files:**
- Create: `app/renderer/src/app/core/ipc.service.ts`, `app/renderer/src/app/core/i18n.ts`, `app/locales/it.json`, `app/locales/en.json`, `app/renderer/src/app/core/ipc.service.spec.ts`
- Modify: `app/renderer/src/main.ts`, `app/renderer/src/app/app.config.ts`

**Interfaces:**
- Produces: `IpcService` con `invoke<K>(channel, payload)` e `on<K>(event)`, tipizzati su `Invocations` ed `Events`; Transloco configurato con i cataloghi condivisi.

- [ ] **Step 1: Scrivere il test che fallisce**

`app/renderer/src/app/core/ipc.service.spec.ts`:

```ts
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { IpcService } from "./ipc.service.ts";

describe("IpcService", () => {
  it("forwards an invocation to the bridge", async () => {
    const invoke = vi.fn().mockResolvedValue([{ id: "p1", title: "Book" }]);
    (globalThis as any).window = { babelbook: { invoke, on: vi.fn() } };
    const service = TestBed.configureTestingModule({}).inject(IpcService);
    await expect(service.invoke("projects.list", {})).resolves.toEqual([{ id: "p1", title: "Book" }]);
    expect(invoke).toHaveBeenCalledWith("projects.list", {});
  });

  it("fails loudly when the bridge is missing instead of pretending to work", () => {
    (globalThis as any).window = {};
    const service = TestBed.configureTestingModule({}).inject(IpcService);
    expect(() => service.invoke("projects.list", {})).toThrow();
  });
});
```

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

Run: `npx vitest run app/renderer/src/app/core/ipc.service.spec.ts`
Atteso: FAIL, `Cannot find module './ipc.service.ts'`.

- [ ] **Step 3: Implementare**

`IpcService` legge `window.babelbook` e **lancia se non c'è**: un bridge assente significa preload non caricato, e un servizio che risponde `undefined` trasforma un errore di configurazione in dieci schermate vuote senza spiegazione.

Per la localizzazione si usa Transloco con caricamento a runtime: la lingua iniziale viene dal main (`app.getLocale()`, poi la preferenza salvata in `setting`), i cataloghi stanno in `app/locales/` e sono **condivisi con il main**, che li usa per il menu di tray, le notifiche e i dialoghi nativi.

**Nessuna stringa rivolta all'utente scritta nei componenti.** I codici che arrivano dal core (`unsupported-encoding`, `unit-fell-back`) diventano chiavi di catalogo: `errors.unsupported-encoding`. Una chiave mancante si vede subito; una frase inglese incastrata in un template no.

- [ ] **Step 4: Eseguire il test**

Run: `npx vitest run app/renderer/src/app/core/ipc.service.spec.ts`
Atteso: PASS, due test.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src app/locales
git commit -m "feat(renderer): a typed bridge that fails loudly, and catalogues shared with the main process"
```

---

### Task 9: La libreria

**Files:**
- Create: `app/main/projects/query.ts`, `app/test/query.test.ts`, `app/renderer/src/app/library/library.component.ts` (con template e stile)
- Modify: `app/main/ipc.ts`

**Interfaces:**
- Produces:

```ts
export interface ProjectSummary {
  id: string; title: string; author?: string;
  coverPath: string | null;
  sourceLanguage: string | null; targetLanguage: string;
  state: string;
  progress: { done: number; total: number };
  layout: "reflowable" | "pre-paginated" | "mixed";
  createdAt: string;
}
export function listProjects(db: DatabaseSync, filter?: string): ProjectSummary[];
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/query.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { listProjects } from "../main/projects/query.ts";

function seeded() {
  const d = openDatabase(":memory:");
  migrate(d, loadMigrations("app/main/db/migrations"));
  d.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state, layout) "
    + "VALUES ('p1','a.epub','Alpha','/w','h','2026-08-01','it','ready','reflowable')").run();
  d.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state, layout) "
    + "VALUES ('p2','b.epub','Beta','/w','h','2026-08-02','fr','running','pre-paginated')").run();
  return d;
}

describe("listProjects", () => {
  it("returns the newest first", () => {
    expect(listProjects(seeded()).map((p) => p.id)).toEqual(["p2", "p1"]);
  });

  it("filters by title, case-insensitively", () => {
    expect(listProjects(seeded(), "alp").map((p) => p.id)).toEqual(["p1"]);
  });

  it("computes progress from the units, in one query", () => {
    const d = seeded();
    d.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
    for (let i = 1; i <= 4; i++) {
      d.prepare("INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, range_start, range_end, state, source_text) "
        + "VALUES (?,?,?,?,?,?,?,?,?)").run(`u${i}`, "p1", "d1", i, `c1.xhtml#${i}`, i, i + 1, "translate", "x");
    }
    d.prepare("INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome) "
      + "VALUES ('t1','u1','Uno','k1',1,'translated')").run();
    const alpha = listProjects(d).find((p) => p.id === "p1")!;
    expect(alpha.progress).toEqual({ done: 1, total: 4 });
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/query.test.ts`
Atteso: FAIL, `Cannot find module '../main/projects/query.ts'`.

- [ ] **Step 3: Implementare la query e il componente**

`listProjects` fa **una sola query** con una sottoselezione per il conteggio: una query per progetto significa una libreria che rallenta man mano che si usa, e il difetto si manifesta mesi dopo, quando i progetti sono trenta.

Il componente è standalone e usa i signal: griglia di copertine con titolo, coppia di lingue, badge di stato, barra di avanzamento e campo di ricerca. Un progetto a impaginazione fissa porta un indicatore, perché **l'avvertenza non vale solo il giorno della creazione**. Le copertine si servono dallo stesso protocollo `app://`, mappato sul workspace del progetto.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/query.test.ts`
Atteso: PASS, tre test.

- [ ] **Step 5: Commit**

```bash
git add app/main/projects/query.ts app/renderer/src/app/library app/test/query.test.ts
git commit -m "feat(app): the library, one query and a fixed-layout badge that stays"
```

---

### Task 10: Nuovo progetto

**Files:**
- Create: `app/renderer/src/app/new-project/new-project.component.ts` (con template), `app/renderer/src/app/new-project/estimate.ts`, `app/renderer/src/app/new-project/estimate.spec.ts`
- Modify: `app/main/ipc.ts`

**Interfaces:**
- Produces:

```ts
export interface Estimate { tokensIn: number; tokensOut: number; cost: number | null }
export function estimate(input: {
  words: number;
  contextOverhead?: number;                          // default 1.5
  priceIn: number | null; priceOut: number | null;   // per milione di token
}): Estimate;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/renderer/src/app/new-project/estimate.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { estimate } from "./estimate.ts";

describe("estimate", () => {
  it("says how many tokens, and no price when the model declares none", () => {
    const e = estimate({ words: 100_000, priceIn: null, priceOut: null });
    expect(e.tokensIn).toBeGreaterThan(100_000);
    expect(e.cost).toBeNull();
  });

  it("counts the context window as tokens paid more than once", () => {
    const withContext = estimate({ words: 100_000, contextOverhead: 1.5, priceIn: 1, priceOut: 1 });
    const without = estimate({ words: 100_000, contextOverhead: 1, priceIn: 1, priceOut: 1 });
    expect(withContext.tokensIn).toBeGreaterThan(without.tokensIn);
  });

  it("charges input and output at their own prices", () => {
    const a = estimate({ words: 1_000_000, priceIn: 1, priceOut: 10 });
    const b = estimate({ words: 1_000_000, priceIn: 10, priceOut: 1 });
    expect(a.cost).toBeGreaterThan(0);
    expect(a.cost).not.toBe(b.cost);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/renderer/src/app/new-project/estimate.spec.ts`
Atteso: FAIL, `Cannot find module './estimate.ts'`.

- [ ] **Step 3: Implementare**

La stima usa un rapporto parole-token dichiarato come costante nominata (circa 1,4 token per parola per l'inglese) e un fattore di contesto che tiene conto delle unità vicine spedite più volte. **È una stima e si presenta come tale**: un ordine di grandezza, non una fattura. Con un modello che non dichiara prezzi si mostrano solo i token, perché mostrare un costo inventato è peggio che non mostrarlo.

Il flusso della schermata: si sceglie il file (dialogo nel main), l'applicazione copia e analizza, compare l'anteprima con copertina, titolo, autore, lingua dichiarata, documenti, unità, parole e gli avvisi di impaginazione fissa e overlay; poi lingua di destinazione, provider, modello e descrizione del libro; infine la stima e il pulsante "Crea".

**L'analisi avviene prima della conferma**, perché è ciò che rende la stima vera. Se l'utente annulla, workspace e righe si cancellano.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/renderer/src/app/new-project/estimate.spec.ts`
Atteso: PASS, tre test.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/new-project
git commit -m "feat(app): create a project from a real analysis, and estimate before spending"
```

---

### Task 11: Una prova end-to-end

**Files:**
- Create: `app/e2e/create-project.spec.ts`, `app/playwright.config.ts`
- Modify: `app/package.json` (script `test:e2e`, dipendenza `@playwright/test`), i template toccati dai `data-testid`

**Interfaces:**
- Produces: `npm run test:e2e -w app`

- [ ] **Step 1: Scrivere il test che fallisce**

`app/e2e/create-project.spec.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { buildEpub } from "../../core/test/corpus/build.ts";

test("creates a project from an EPUB and shows it in the library", async () => {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-e2e-"));
  const epub = join(dir, "book.epub");
  await writeFile(epub, await buildEpub({
    title: "End To End", language: "en",
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two</p>" }],
  }));

  const app = await electron.launch({
    args: ["."],
    cwd: "app",
    env: { ...process.env, BABELBOOK_USER_DATA: dir, BABELBOOK_EPUB_FOR_TEST: epub },
  });
  const window = await app.firstWindow();

  await window.getByTestId("new-project").click();
  await window.getByTestId("choose-epub").click();
  await expect(window.getByTestId("preview-title")).toHaveText("End To End");
  await window.getByTestId("target-language").selectOption("it");
  await window.getByTestId("create").click();

  await expect(window.getByTestId("library").getByText("End To End")).toBeVisible();
  await app.close();
});
```

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

Run: `npm run test:e2e -w app`
Atteso: FAIL, i `data-testid` non esistono ancora nei template.

- [ ] **Step 3: Rendere l'applicazione pilotabile**

Aggiungere i `data-testid` ai punti nominati dal test. Servono due variabili d'ambiente, lette **solo dal main e in un punto solo**:

- `BABELBOOK_USER_DATA` sostituisce `app.getPath("userData")`, così la prova non tocca i dati veri;
- `BABELBOOK_EPUB_FOR_TEST` fa restituire a `project.chooseEpub` quel percorso invece di aprire il dialogo nativo, che Playwright non può pilotare.

Vanno lette in un punto solo e documentate lì: una scorciatoia di test sparsa nel codice diventa, prima o poi, un percorso di produzione per sbaglio.

- [ ] **Step 4: Eseguire la prova**

Run: `npm run test:e2e -w app`
Atteso: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/e2e app/playwright.config.ts app/package.json app/renderer/src
git commit -m "test(app): drive the real window from an EPUB to the library"
```

---

## Definizione di finito

- `npm test` alla radice esegue core e main, tutto verde; `npm run test:e2e -w app` passa.
- L'applicazione si apre, crea un progetto da un EPUB **senza alcun provider configurato**, e lo mostra nella libreria con copertina, lingue, avanzamento a zero e gli avvisi di impaginazione fissa e overlay quando servono.
- La stessa batteria di contratto passa contro `FakeStore` e `SqliteProjectStore`.
- Un file non-EPUB viene rifiutato con un errore che nomina il formato.
- Il renderer non ha accesso a Node, e ogni canale IPC è dichiarato in un file solo.

**Non è compreso**: tradurre. Nessuna chiamata a un modello, nessuna macchina a stati, nessun gate: arrivano nel piano 4.
