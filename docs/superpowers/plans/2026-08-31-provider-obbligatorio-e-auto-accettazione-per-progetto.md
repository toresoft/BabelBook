# Provider obbligatorio e auto-accettazione per progetto — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un progetto non può più esistere senza un provider, e ciò che si accetta senza chiedere — i termini, le esclusioni — lo decide il libro invece dell'applicazione, con entrambe le porte aperte per default.

**Architecture:** Due colonne nuove su `project` sostituiscono due righe della tabella `setting`; una guardia sola, condivisa da `project.create` e `project.update`, tiene l'invariante «un progetto ha un provider» al confine IPC invece che nello schema, dove una colonna nullable non può dirla senza rompere i database già in giro. La corsa smette di chiedere alle impostazioni e legge dalla riga del progetto che interroga comunque. In superficie: la libreria spegne il bottone quando non c'è niente con cui tradurre, `/new` non offre più «Nessuno», e nasce la prima schermata di modifica di un progetto.

**Tech Stack:** Node 24.18.0, TypeScript ESM con sola sintassi cancellabile in `core/`, node:sqlite, Electron, Angular 22.1, daisyUI 5, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-31-provider-obbligatorio-e-auto-accettazione-per-progetto-design.md`

## Global Constraints

- **Codice e commenti in inglese.** Questo piano è in italiano; il codice no.
- **Ogni stringa esiste in `app/locales/en.json` e in `app/locales/it.json`.** Nessuna frase scritta nel template.
- **Nessun colore fuori da `app/renderer/src/styles.css`.** `app/test/styles.test.ts` fallisce su qualunque `#rrggbb` in un foglio di componente: si usano i token (`--text`, `--surface`, `--line`, `--accent`, `--danger`, `--warning`, `--ok`, `--rest`, `--lift`, e i loro `-soft`/`-line`).
- **`app/shared/*.ts` non dipende da niente**: i tipi che attraversano l'IPC non importano il processo main.
- **`core/` non si tocca in tutto il piano.** `RunConfig` mantiene la forma che ha; cambia solo chi la costruisce.
- **I codici d'errore sono codici, mai frasi.** L'interfaccia compone la frase dal suo catalogo, nella lingua di chi legge.
- Comandi dalla radice del repo. `export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`.
- Test: `npx vitest run <percorso>` per un file, `npm test` per tutto, `npm run test:ui -w app` per i componenti, `npm run test:e2e -w app` per le prove end-to-end, `npm run typecheck` **sempre** prima di commettere.
- **Alcune spec e2e erano già rosse prima di questo piano** (`STATO.md` ne conta cinque). Prima di iniziare, esegui `npm run test:e2e -w app` e annota quante e quali falliscono: alla fine devono essere le stesse, non una di più.
- Un commit per task, con il messaggio indicato.

## Struttura dei file

| File | Responsabilità |
|---|---|
| `app/main/db/migrations/015-project-auto-accept.sql` | **Nuovo.** Le due colonne, e i libri già in libreria che tengono il comportamento di ieri. |
| `app/main/projects/provider.ts` | **Nuovo.** La guardia: il provider e il modello esistono, o la richiesta non è una richiesta. |
| `app/main/projects/create.ts` | Chiama la guardia prima di toccare il disco; scrive provider e modello senza `?? null`. |
| `app/main/ipc.ts` | `project.update` chiama la guardia e scrive le due proprietà; `readSettings` smette di leggerle; `confirmQuestion` conosce `contractChange`. |
| `app/main/projects/detail.ts` | Il DTO del progetto porta le due proprietà, che la schermata di modifica legge. |
| `app/main/run/runtime.ts` | Le due proprietà arrivano dalla riga del progetto, non da `deps.settings()`. |
| `app/shared/dto.ts`, `app/shared/channels.ts` | I tipi: `Create`/`Update`/`ProjectDetail` guadagnano, `Settings` perde; `CONFIRM_KINDS` guadagna `contractChange`. |
| `app/renderer/src/app/core/languages.ts` | **Nuovo.** Le lingue di destinazione, dichiarate una volta per le due schermate che le offrono. |
| `app/renderer/src/app/new-project/new-project.ts,.html` | Provider obbligatorio e preselezionato, i due interruttori, «Crea» che si spegne. |
| `app/renderer/src/app/library/library.ts,.html,.css` | «Nuovo progetto» spento quando non c'è niente con cui tradurre. |
| `app/renderer/src/app/project/side/project-settings.ts,.html` | **Nuovo.** La schermata di modifica, dentro il guscio modale che la colonna già usa. |
| `app/renderer/src/app/project/side/side.ts,.html,.css` | Il bottone che la apre, spento mentre il motore è vivo. |
| `app/renderer/src/app/settings/preferences.html` | Perde i due interruttori globali. |
| `app/e2e/support.ts` | **Modificato.** `seedProvider`: un provider scritto nel database che l'applicazione sta per aprire. |

---

### Task 1: La migrazione

Le due colonne, e la promessa che nessun libro già in libreria cambia comportamento da solo. Atterra per prima e da sola: tutto il resto la dà per presente.

**Files:**
- Create: `app/main/db/migrations/015-project-auto-accept.sql`
- Test: `app/test/migrate.test.ts`

**Interfaces:**
- Produces: `project.auto_accept_terms` e `project.auto_accept_exclusions`, `INTEGER NOT NULL DEFAULT 1 CHECK (… IN (0, 1))`. Ogni task successivo le legge sotto questi nomi.

- [ ] **Step 1: Scrivi i test che falliscono**

In coda al `describe("migrate")` di `app/test/migrate.test.ts`:

```ts
  it("brings the two auto-acceptances down onto the projects that already exist", () => {
    const db = openDatabase(":memory:");
    const migrations = loadMigrations("app/main/db/migrations");
    migrate(db, migrations.filter((migration) => migration.id < "015-project-auto-accept"));

    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           target_language, state)
      VALUES ('p1', 'a.epub', 'A', '/w/p1', 'sha', '2026-08-31T00:00:00.000Z', 'it', 'ready'),
             ('p2', 'b.epub', 'B', '/w/p2', 'sha', '2026-08-31T00:00:00.000Z', 'it', 'ready')
    `).run();
    db.prepare("INSERT INTO setting (key, value) VALUES ('autoAcceptTerms', 'true')").run();

    expect(migrate(db, migrations).applied).toEqual(["015-project-auto-accept"]);

    // The row said true, so both books keep walking past the terms gate. The
    // exclusions row was absent, and absent is how readSettings spelled false:
    // a book that stopped there yesterday stops there today.
    expect(db.prepare(`
      SELECT auto_accept_terms AS terms, auto_accept_exclusions AS exclusions
        FROM project ORDER BY id
    `).all()).toEqual([{ terms: 1, exclusions: 0 }, { terms: 1, exclusions: 0 }]);

    // And the global setting is gone: two places to read one fact is one too many.
    expect(db.prepare("SELECT count(*) AS n FROM setting WHERE key LIKE 'autoAccept%'").get())
      .toEqual({ n: 0 });
  });

  it("opens both gates on a project created after the migration", () => {
    const db = openDatabase(":memory:");
    migrate(db, loadMigrations("app/main/db/migrations"));

    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           target_language, state)
      VALUES ('p1', 'a.epub', 'A', '/w/p1', 'sha', '2026-08-31T00:00:00.000Z', 'it', 'ready')
    `).run();

    expect(db.prepare(`
      SELECT auto_accept_terms AS terms, auto_accept_exclusions AS exclusions FROM project
    `).get()).toEqual({ terms: 1, exclusions: 1 });
  });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run app/test/migrate.test.ts`
Expected: FAIL — `no such column: auto_accept_terms`.

- [ ] **Step 3: Scrivi la migrazione**

`app/main/db/migrations/015-project-auto-accept.sql`:

```sql
-- What a run walks past without asking belongs to the book, not to the
-- application.
--
-- Both gates now open by default: a translation that stops twice per book is
-- the exception someone asks for, not the rule everyone meets. The choice is
-- offered where the book is created and where it is edited, in plain sight,
-- which is what the old default in `channels.ts` was defending — it defended
-- it by making the choice for everybody, and by burying it in the settings.
ALTER TABLE project ADD COLUMN auto_accept_terms INTEGER NOT NULL DEFAULT 1
  CHECK (auto_accept_terms IN (0, 1));
ALTER TABLE project ADD COLUMN auto_accept_exclusions INTEGER NOT NULL DEFAULT 1
  CHECK (auto_accept_exclusions IN (0, 1));

-- The books already on the shelf keep the behaviour they had yesterday. The
-- CASE is unconditional on purpose: an absent row is how `readSettings` spelled
-- false, so absent must land as 0 here. The DEFAULT 1 above is for the projects
-- that do not exist yet, and only for them.
UPDATE project SET
  auto_accept_terms      = CASE WHEN (SELECT value FROM setting WHERE key = 'autoAcceptTerms')      = 'true' THEN 1 ELSE 0 END,
  auto_accept_exclusions = CASE WHEN (SELECT value FROM setting WHERE key = 'autoAcceptExclusions') = 'true' THEN 1 ELSE 0 END;

DELETE FROM setting WHERE key IN ('autoAcceptTerms', 'autoAcceptExclusions');

-- `provider_id` stays nullable, and that is deliberate.
--
-- From here on a project cannot be created or updated without a provider — the
-- guard lives in `app/main/projects/provider.ts`, at the IPC boundary. It could
-- not live in this file: a database out there may already hold projects with no
-- provider, and the only way to make the column NOT NULL would be to pick a
-- model on their owner's behalf. A column that reads as optional and is not is
-- worth this comment.
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx vitest run app/test/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Esegui la suite del main e verifica che nulla si sia rotto**

Run: `npx vitest run app/test`
Expected: PASS. Le colonne hanno un default, quindi nessuna `INSERT` esistente cambia.

- [ ] **Step 6: Commit**

```bash
git add app/main/db/migrations/015-project-auto-accept.sql app/test/migrate.test.ts
git commit -m "feat(db): le due auto-accettazioni scendono sulla riga del progetto"
```

---

### Task 2: La guardia sul provider, e `project.create`

Una funzione sola che dice se una scelta è una scelta, chiamata prima che il disco venga toccato. Il resto del piano la riusa senza riscriverla.

**Files:**
- Create: `app/main/projects/provider.ts`
- Modify: `app/main/projects/create.ts:66-95` (il commento in testa, e l'inizio di `createProject`), `app/main/projects/create.ts:145-160` (la `INSERT`)
- Modify: `app/shared/dto.ts:51-58` (`CreateProjectRequest`)
- Test: `app/test/create.test.ts`
- Test (aggiornamento meccanico): `app/test/ipc.test.ts`, `app/test/run-runtime.test.ts:75`, `app/test/run-compose.test.ts:32`

**Interfaces:**
- Produces: `assertProviderChosen(db, providerId, modelId): void` e `ProviderChoiceError` con `.code` fra `PROVIDER_REQUIRED`, `UNKNOWN_PROVIDER`, `UNKNOWN_MODEL`. Il Task 3 la chiama da `project.update`.
- Produces: `CreateProjectRequest.providerId: string` e `.modelId: string`, obbligatori. Il Task 4 li manda dal renderer.

- [ ] **Step 1: Scrivi i test che falliscono**

In `app/test/create.test.ts`, sostituisci `setup()` con una versione che semina un provider, e aggiungi la costante che ogni chiamata userà:

```ts
/** A provider and a model that exist, because from now on a project needs both. */
const CHOICE = { providerId: "pv1", modelId: "m1" } as const;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-create-"));
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO provider (id, name, route, headers, options)
    VALUES ('pv1', 'Acme', 'openai-compatible', '{}', '{}')
  `).run();
  db.prepare(`
    INSERT INTO provider_model (id, provider_id, model_id, display_name)
    VALUES ('pm1', 'pv1', 'm1', 'M1')
  `).run();
  return { dir, db };
}
```

Poi, in coda al `describe("createProject")`:

```ts
  it("refuses a project with no provider, and leaves nothing behind on the disk", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      title: "The Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    });

    await expect(createProject(db, dir, {
      epubPath: epub, targetLanguage: "it", providerId: "", modelId: "",
    })).rejects.toMatchObject({ code: "PROVIDER_REQUIRED" });

    expect(count(db, "project")).toBe(0);
    // The refusal has to come before the workspace: an EPUB copied for a
    // project that was then refused is the half-ingestion this file exists
    // not to leave behind.
    expect(existsSync(join(dir, "projects"))).toBe(false);
  });

  it("refuses a provider that does not exist, and a model that is not its", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      title: "The Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    });

    await expect(createProject(db, dir, {
      epubPath: epub, targetLanguage: "it", providerId: "nope", modelId: "m1",
    })).rejects.toMatchObject({ code: "UNKNOWN_PROVIDER" });

    await expect(createProject(db, dir, {
      epubPath: epub, targetLanguage: "it", providerId: "pv1", modelId: "nope",
    })).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
  });

  it("writes the chosen provider and model onto the row", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      title: "The Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    });

    const created = await createProject(db, dir, {
      epubPath: epub, targetLanguage: "it", ...CHOICE,
    });

    expect(db.prepare("SELECT provider_id AS p, model_id AS m FROM project WHERE id = ?")
      .get(created.id)).toEqual({ p: "pv1", m: "m1" });
  });
```

Infine, aggiungi `...CHOICE` alle tredici chiamate `createProject(db, dir, { epubPath: …, targetLanguage: "it" })` già presenti nel file — diventano `{ epubPath: …, targetLanguage: "it", ...CHOICE }`. Le due che passano un file non-EPUB (`notEpub`, `zip`) e quella che passa un EPUB rotto (`broken`) la ricevono ugualmente: la guardia passa, e il rifiuto atteso resta quello sul formato.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run app/test/create.test.ts`
Expected: FAIL — i tre nuovi cadono, gli altri passano (i campi in più sono ancora ignorati).

- [ ] **Step 3: Scrivi la guardia**

`app/main/projects/provider.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

/**
 * A choice the request had to carry and did not.
 *
 * Three codes rather than one message: "the provider is wrong" leaves the
 * interface to guess whether nothing was chosen, whether the provider was
 * disconnected since, or whether the model belongs to somebody else — three
 * different sentences, and only the boundary knows which one is true.
 */
export class ProviderChoiceError extends Error {
  code: "PROVIDER_REQUIRED" | "UNKNOWN_PROVIDER" | "UNKNOWN_MODEL";

  constructor(code: "PROVIDER_REQUIRED" | "UNKNOWN_PROVIDER" | "UNKNOWN_MODEL") {
    super(code);
    this.name = "ProviderChoiceError";
    this.code = code;
  }
}

/**
 * The provider and the model exist, or the request is not a request.
 *
 * This is where the invariant "a project has a provider" lives. It cannot live
 * in the schema: `project.provider_id` is nullable and stays that way, because
 * databases already out there hold projects created before the rule, and the
 * only way to make the column NOT NULL would be to pick a model on their
 * owner's behalf.
 *
 * Both create and update call it, and both call it *before* doing anything
 * that would have to be undone.
 */
export function assertProviderChosen(
  db: DatabaseSync,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): void {
  if (providerId === undefined || providerId === null || providerId === ""
    || modelId === undefined || modelId === null || modelId === "") {
    throw new ProviderChoiceError("PROVIDER_REQUIRED");
  }

  const provider = db.prepare("SELECT 1 AS ok FROM provider WHERE id = ?").get(providerId);
  if (provider === undefined) throw new ProviderChoiceError("UNKNOWN_PROVIDER");

  // The pair, not the model alone: `provider_model` is unique on
  // (provider_id, model_id), so a model that belongs to another endpoint is a
  // different question with the same name.
  const model = db.prepare(
    "SELECT 1 AS ok FROM provider_model WHERE provider_id = ? AND model_id = ?",
  ).get(providerId, modelId);
  if (model === undefined) throw new ProviderChoiceError("UNKNOWN_MODEL");
}
```

- [ ] **Step 4: Rendi obbligatoria la scelta nel contratto**

In `app/shared/dto.ts`, `CreateProjectRequest`:

```ts
export interface CreateProjectRequest {
  epubPath: string;
  targetLanguage: string;
  sourceLanguage?: string;
  description?: string;
  /** Not optional any more: a project without a provider cannot be translated. */
  providerId: string;
  modelId: string;
}
```

- [ ] **Step 5: Chiama la guardia in `createProject`**

In `app/main/projects/create.ts`, aggiungi l'import:

```ts
import { assertProviderChosen } from "./provider.ts";
```

Sostituisci il paragrafo del commento in testa a `createProject` che dice il contrario di ciò che ora è vero:

```
 * A project can be created before any provider is configured, and the counts
 * it produces are what the interface shows the user *before* asking them to
 * pay for a translation.
```

con:

```
 * The counts it produces are what the interface shows the user *before* asking
 * them to pay for a translation — nothing here calls a model. What it does
 * require is that a model has been *chosen*: a project with no provider is a
 * book nobody can translate, and the library refuses to offer one.
```

Poi, come primissime righe del corpo di `createProject`, prima di `const analysisStartedAt`:

```ts
  // Before the file is read and long before the workspace exists: a refusal
  // that had already copied an EPUB would leave a directory nobody owns.
  assertProviderChosen(db, input.providerId, input.modelId);
```

E nella `INSERT`, sostituisci `input.providerId ?? null, input.modelId ?? null` con `input.providerId, input.modelId`.

- [ ] **Step 6: Esegui i test e verifica che passino**

Run: `npx vitest run app/test/create.test.ts`
Expected: PASS.

- [ ] **Step 7: Aggiorna gli altri chiamanti di `createProject`**

In `app/test/run-runtime.test.ts:75` e `app/test/run-compose.test.ts:32` la chiamata diventa `{ epubPath, targetLanguage: "it", providerId: "pv1", modelId: "m1" }`, e la funzione di setup di ciascun file semina il provider con le stesse due `INSERT` del Task 2 Step 1. **Attenzione:** se il file semina già un provider con un altro id, usa quello invece di aggiungerne un secondo.

In `app/test/ipc.test.ts`, il costruttore `deps()` semina il provider subito dopo `migrate(...)`:

```ts
  db.prepare(`
    INSERT INTO provider (id, name, route, headers, options)
    VALUES ('pv1', 'Acme', 'openai-compatible', '{}', '{}')
  `).run();
  db.prepare(`
    INSERT INTO provider_model (id, provider_id, model_id, display_name)
    VALUES ('pm1', 'pv1', 'm1', 'M1')
  `).run();
```

e le tre chiamate `handlers["project.create"]({ epubPath: epub, targetLanguage: "it" })` (righe 100, 113, 177) ricevono `providerId: "pv1", modelId: "m1"`.

- [ ] **Step 8: Esegui tutta la suite del main e il typecheck**

Run: `npx vitest run app/test && npm run typecheck`
Expected: PASS. Se `typecheck` segnala `new-project.ts` — che ancora chiama `project.create` senza provider — **è il buco che chiude il Task 4**: annotalo e vai avanti, non aggiustarlo qui.

- [ ] **Step 9: Commit**

```bash
git add app/main/projects/provider.ts app/main/projects/create.ts app/shared/dto.ts \
        app/test/create.test.ts app/test/ipc.test.ts app/test/run-runtime.test.ts \
        app/test/run-compose.test.ts
git commit -m "feat(projects): un progetto non nasce senza un provider che esiste"
```

---

### Task 3: `project.update` — la guardia e le due proprietà

Lo stesso rifiuto sull'altra porta, più i due booleani che ora si possono scrivere.

**Files:**
- Modify: `app/main/ipc.ts:268-302` (`project.update`)
- Modify: `app/shared/dto.ts:81-89` (`UpdateProjectRequest`)
- Test: `app/test/ipc.test.ts`

**Interfaces:**
- Consumes: `assertProviderChosen` dal Task 2.
- Produces: `UpdateProjectRequest.autoAcceptTerms?: boolean` e `.autoAcceptExclusions?: boolean`. Il Task 4 e il Task 9 li mandano.

- [ ] **Step 1: Scrivi i test che falliscono**

In `app/test/ipc.test.ts`, dentro il `describe` che copre `project.update` (o in coda al file, in un `describe("project.update")` nuovo):

```ts
describe("project.update and the provider", () => {
  it("refuses an empty provider, and leaves the row as it was", async () => {
    const { deps: d, db } = await deps();
    const handlers = buildHandlers(d);
    const dir = await mkdtemp(join(tmpdir(), "babelbook-update-"));
    const epub = join(dir, "book.epub");
    await writeFile(epub, await buildEpub({
      title: "A Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    }));
    const created = await handlers["project.create"]({
      epubPath: epub, targetLanguage: "it", providerId: "pv1", modelId: "m1",
    });

    // An empty string is not "leave it alone" — `coalesce` would have written
    // it, and the row would name a provider that cannot exist.
    await expect(handlers["project.update"]({ id: created.id, providerId: "", modelId: "" }))
      .rejects.toMatchObject({ code: "PROVIDER_REQUIRED" });

    expect(db.prepare("SELECT provider_id AS p FROM project WHERE id = ?").get(created.id))
      .toEqual({ p: "pv1" });
  });

  it("writes the two auto-acceptances, and leaves them alone when they are not sent", async () => {
    const { deps: d, db } = await deps();
    const handlers = buildHandlers(d);
    const dir = await mkdtemp(join(tmpdir(), "babelbook-update-"));
    const epub = join(dir, "book.epub");
    await writeFile(epub, await buildEpub({
      title: "A Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    }));
    const created = await handlers["project.create"]({
      epubPath: epub, targetLanguage: "it", providerId: "pv1", modelId: "m1",
    });

    const read = () => db.prepare(`
      SELECT auto_accept_terms AS terms, auto_accept_exclusions AS exclusions
        FROM project WHERE id = ?
    `).get(created.id);

    expect(read()).toEqual({ terms: 1, exclusions: 1 });

    await handlers["project.update"]({ id: created.id, autoAcceptTerms: false });
    expect(read()).toEqual({ terms: 0, exclusions: 1 });

    // A patch says what it says. A description does not reopen a gate.
    await handlers["project.update"]({ id: created.id, description: "A note" });
    expect(read()).toEqual({ terms: 0, exclusions: 1 });
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run app/test/ipc.test.ts -t "project.update and the provider"`
Expected: FAIL — il primo perché nulla rifiuta, il secondo perché la `UPDATE` non conosce le due colonne.

- [ ] **Step 3: Estendi il contratto**

In `app/shared/dto.ts`:

```ts
export interface UpdateProjectRequest {
  id: string;
  targetLanguage?: string;
  sourceLanguage?: string | null;
  description?: string;
  /**
   * The provider and model this book will be translated with. Optional
   * because this is a patch — but not nullable, and never empty: a project
   * that has one may not be left without.
   */
  providerId?: string;
  modelId?: string;
  /** What this book walks past without asking. Absent means "leave it". */
  autoAcceptTerms?: boolean;
  autoAcceptExclusions?: boolean;
}
```

- [ ] **Step 4: Chiama la guardia e scrivi le due colonne**

In `app/main/ipc.ts`, importa la guardia:

```ts
import { assertProviderChosen } from "./projects/provider.ts";
```

e riscrivi l'handler `project.update`:

```ts
    "project.update": async ({
      id, targetLanguage, sourceLanguage, description, providerId, modelId,
      autoAcceptTerms, autoAcceptExclusions,
    }) => {
      // The language decides the cache key, so it is not a label: changing it
      // makes every stored translation belong to another contract. Confirming
      // it before any run starts is the cheap moment to get it right.
      const before = deps.db.prepare("SELECT state FROM project WHERE id = ?").get(id) as
        { state: string } | undefined;
      if (before === undefined) throw new Error(`no such project: ${id}`);

      // Only when the patch speaks about them. Silence means "leave it", and
      // a project that already has a provider must not be able to lose it:
      // `coalesce` below would happily write an empty string.
      if (providerId !== undefined || modelId !== undefined) {
        assertProviderChosen(deps.db, providerId, modelId);
      }

      deps.db.exec("SAVEPOINT babelbook_project_update");
      try {
        deps.db.prepare(`
          UPDATE project
             SET target_language = coalesce(?, target_language),
                 source_language = coalesce(?, source_language),
                 description     = coalesce(?, description),
                 provider_id     = coalesce(?, provider_id),
                 model_id        = coalesce(?, model_id),
                 auto_accept_terms      = coalesce(?, auto_accept_terms),
                 auto_accept_exclusions = coalesce(?, auto_accept_exclusions),
                 state = CASE
                   WHEN state = 'needs-language' AND coalesce(?, source_language) IS NOT NULL
                     THEN 'ready' ELSE state END
           WHERE id = ?
        `).run(targetLanguage ?? null, sourceLanguage ?? null, description ?? null,
          providerId ?? null, modelId ?? null,
          autoAcceptTerms === undefined ? null : (autoAcceptTerms ? 1 : 0),
          autoAcceptExclusions === undefined ? null : (autoAcceptExclusions ? 1 : 0),
          sourceLanguage ?? null, id);

        const after = deps.db.prepare("SELECT state FROM project WHERE id = ?").get(id) as { state: string };
        if (after.state !== before.state) {
          enterState(deps.db, { projectId: id, kind: "project", name: after.state });
        }
        deps.db.exec("RELEASE SAVEPOINT babelbook_project_update");
      } catch (error) {
        deps.db.exec("ROLLBACK TO SAVEPOINT babelbook_project_update");
        deps.db.exec("RELEASE SAVEPOINT babelbook_project_update");
        throw error;
      }
      deps.broadcast("project.changed", { id });
    },
```

Nota: `providerId !== undefined || modelId !== undefined` fa sì che mandarne uno solo venga rifiutato con `PROVIDER_REQUIRED`. È voluto — mezzo cambio di configurazione non è un cambio di configurazione.

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `npx vitest run app/test/ipc.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/main/ipc.ts app/shared/dto.ts app/test/ipc.test.ts
git commit -m "feat(projects): la modifica non può togliere il provider, e sa scrivere i due gate"
```

---

### Task 4: `/new` — il provider obbligatorio e i due interruttori

Chiude il buco aperto dal Task 2: da qui l'applicazione ricompila e si usa di nuovo.

**Files:**
- Modify: `app/renderer/src/app/new-project/new-project.ts`
- Modify: `app/renderer/src/app/new-project/new-project.html:70-80` (il `select` del provider) e in coda al modulo
- Modify: `app/locales/it.json`, `app/locales/en.json`
- Test: `app/renderer/src/app/new-project/new-project.spec.ts`

**Interfaces:**
- Consumes: `CreateProjectRequest.providerId/modelId` obbligatori (Task 2), `UpdateProjectRequest.autoAccept*` (Task 3).
- Produces: nel DOM, `[data-testid=auto-terms]` e `[data-testid=auto-exclusions]` — gli stessi nomi che le preferenze perderanno nel Task 7, così il Task 10 può cliccarli in `/new`.

- [ ] **Step 1: Scrivi i test che falliscono**

In coda al `describe("NewProject")` di `app/renderer/src/app/new-project/new-project.spec.ts`:

```ts
  it("chooses a provider for the form, because the project is written with one", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    // Preselected before the file is even opened: `project.create` carries the
    // choice, and it is called the moment the EPUB is chosen.
    expect(fixture.componentInstance.providerId()).toBe("pv1");
    expect(fixture.componentInstance.modelId()).toBe("m1");

    await chosen(fixture);
    expect(calls(invoke, "project.create")[0]![1])
      .toMatchObject({ providerId: "pv1", modelId: "m1" });
  });

  it("does not offer 'no provider' any more", async () => {
    const { fixture } = mount();
    await chosen(fixture);
    fixture.detectChanges();

    const options = [...fixture.nativeElement
      .querySelectorAll("[data-testid=provider] option")] as HTMLOptionElement[];
    expect(options.map((option) => option.value)).toEqual(["pv1"]);
  });

  it("sends both auto-acceptances, on by default", async () => {
    const { fixture, invoke } = mount();
    await chosen(fixture);
    fixture.detectChanges();

    await fixture.componentInstance.create();

    expect(calls(invoke, "project.update")[0]![1])
      .toMatchObject({ autoAcceptTerms: true, autoAcceptExclusions: true });
  });

  it("refuses to create while nothing can translate the book", async () => {
    const { fixture } = mount(bridge({ "providers.list": [] }));
    await fixture.whenStable();
    fixture.detectChanges();

    // Whoever reached this screen with no provider — a typed URL, a provider
    // disconnected in another window — is told what is missing, not left with
    // a button that opens a form they cannot finish.
    expect(fixture.nativeElement.querySelector("[data-testid=choose-epub]")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=needs-provider]")).not.toBeNull();
  });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npm run test:ui -w app -- --filter new-project`
(Se il builder non accetta il filtro, esegui `npm run test:ui -w app` e leggi i quattro casi rossi.)
Expected: FAIL — quattro rossi.

- [ ] **Step 3: Riscrivi il componente**

In `app/renderer/src/app/new-project/new-project.ts`, dentro la classe `NewProject`:

```ts
  readonly autoAcceptTerms = signal(true);
  readonly autoAcceptExclusions = signal(true);

  /** A provider with no models cannot be chosen from, so it does not count. */
  readonly usable = computed(() => this.providers().filter((provider) => provider.models.length > 0));

  readonly canCreate = computed(() => this.providerId() !== null && this.modelId() !== null);
```

e sostituisci `loadProviders`:

```ts
  async loadProviders(): Promise<void> {
    this.providers.set(await this.#ipc.invoke("providers.list", undefined));

    // Preselected, and not out of impatience: `project.create` now carries the
    // choice, and it is called the moment the file is chosen — before this
    // form is on screen at all. Without a preselection the first project of
    // every session would be refused by the main process.
    const first = this.usable()[0];
    if (first !== undefined) this.pickProvider(first.id);
  }
```

In `choose()`, la chiamata a `project.create` porta la scelta:

```ts
  async choose(): Promise<void> {
    this.failure.set(null);
    const providerId = this.providerId();
    const modelId = this.modelId();
    if (providerId === null || modelId === null) return;

    const chosen = await this.#ipc.invoke("project.chooseEpub", undefined);
    if (chosen === null) return;

    this.chosenName.set(chosen.name);
    this.analysing.set(true);
    try {
      const created = await this.#ipc.invoke("project.create", {
        epubPath: chosen.path,
        targetLanguage: this.targetLanguage(),
        providerId,
        modelId,
      });
      this.project.set(created);
      this.sourceLanguage.set(created.declaredLanguage ?? "");
    } catch (error) {
      const failed = error as { code?: string; format?: string };
      this.failure.set(failed.code === "UNSUPPORTED_FORMAT"
        ? { key: "codes.unsupported-format", params: { format: failed.format ?? "?" } }
        : { key: "errors.noBridge" });
    } finally {
      this.analysing.set(false);
    }
  }
```

e in `create()`, la `project.update` porta anche i due booleani:

```ts
    await this.#ipc.invoke("project.update", {
      id: found.id,
      targetLanguage: this.targetLanguage(),
      sourceLanguage: this.sourceLanguage() === "" ? null : this.sourceLanguage(),
      description: this.description(),
      providerId: this.providerId() ?? undefined,
      modelId: this.modelId() ?? undefined,
      autoAcceptTerms: this.autoAcceptTerms(),
      autoAcceptExclusions: this.autoAcceptExclusions(),
    });
```

- [ ] **Step 4: Riscrivi il template**

In `app/renderer/src/app/new-project/new-project.html`, avvolgi il bottone «Scegli un EPUB» (righe 4-6) così:

```html
  @if (usable().length === 0) {
    <p class="new__needsProvider" data-testid="needs-provider">
      {{ t('newProject.needsProvider') }}
      <a routerLink="/settings/providers">{{ t('newProject.toProviders') }}</a>
    </p>
  } @else {
    <button type="button" class="btn new__choose" data-testid="choose-epub" (click)="choose()">
      {{ t('newProject.chooseEpub') }}
    </button>
  }
```

Aggiungi `RouterLink` agli `imports` del componente (`import { RouterLink } from "@angular/router";`).

Nel `select` del provider, togli la riga dell'opzione nulla e ciclare su `usable()`:

```html
    <label>
      {{ t('newProject.provider') }}
      <select class="select" data-testid="provider" [ngModel]="providerId()"
              (ngModelChange)="pickProvider($event)">
        @for (provider of usable(); track provider.id) {
          <option [value]="provider.id">{{ provider.name }}</option>
        }
      </select>
    </label>
```

Dopo il `textarea` della descrizione, i due interruttori:

```html
    <label class="new__check">
      <input type="checkbox" class="checkbox" data-testid="auto-terms"
             [ngModel]="autoAcceptTerms()" (ngModelChange)="autoAcceptTerms.set($event)" />
      <span>
        {{ t('newProject.autoAcceptTerms') }}
        <small>{{ t('newProject.autoAcceptTermsHint') }}</small>
      </span>
    </label>

    <label class="new__check">
      <input type="checkbox" class="checkbox" data-testid="auto-exclusions"
             [ngModel]="autoAcceptExclusions()" (ngModelChange)="autoAcceptExclusions.set($event)" />
      <span>
        {{ t('newProject.autoAcceptExclusions') }}
        <small>{{ t('newProject.autoAcceptExclusionsHint') }}</small>
      </span>
    </label>
```

E «Crea» si spegne:

```html
      <button type="button" class="btn btn-primary" data-testid="create"
              [disabled]="!canCreate()" (click)="create()">
        {{ t('newProject.create') }}
      </button>
```

In `app/renderer/src/app/new-project/new-project.css`, riusa la regola che `prefs__check` già usa per allineare casella e testo (copiala da `app/renderer/src/app/settings/preferences.css` sotto il nome `.new__check`, senza introdurre colori).

- [ ] **Step 5: Le stringhe, in tutti e due i cataloghi**

In `app/locales/it.json`, dentro `newProject`: togli `noProvider`, aggiungi

```json
    "needsProvider": "Serve un provider per tradurre un libro. Non ne hai ancora configurato uno.",
    "toProviders": "Vai ai provider",
    "autoAcceptTerms": "Accetta i termini senza chiedere",
    "autoAcceptTermsHint": "La traduzione non si ferma per farti approvare i termini estratti.",
    "autoAcceptExclusions": "Accetta le esclusioni senza chiedere",
    "autoAcceptExclusionsHint": "Non ti verrà chiesto di controllare cosa non verrà tradotto."
```

In `app/locales/en.json`, dentro `newProject`: togli `noProvider`, aggiungi

```json
    "needsProvider": "Translating a book takes a provider. You have not configured one yet.",
    "toProviders": "Go to providers",
    "autoAcceptTerms": "Accept the terms without asking",
    "autoAcceptTermsHint": "The translation will not stop for you to approve the extracted terms.",
    "autoAcceptExclusions": "Accept the exclusions without asking",
    "autoAcceptExclusionsHint": "You will not be asked to review what is left untranslated."
```

- [ ] **Step 6: Esegui i test e verifica che passino**

Run: `npm run test:ui -w app && npm run typecheck`
Expected: PASS. Il typecheck deve essere pulito: il buco del Task 2 Step 8 è chiuso.

- [ ] **Step 7: Commit**

```bash
git add app/renderer/src/app/new-project app/locales/it.json app/locales/en.json
git commit -m "feat(new-project): il provider si sceglie sempre, e i due gate si decidono qui"
```

---

### Task 5: `ProjectDetail` porta le due proprietà

La schermata di modifica dovrà leggerle; il DTO è l'unico posto da cui può.

**Files:**
- Modify: `app/main/projects/detail.ts:15-30` (`interface`), `:45-95` (la `SELECT`), `:110-125` (la mappatura)
- Modify: `app/shared/dto.ts:115-125` (`ProjectDetail`)
- Test: `app/test/project-detail.test.ts`

**Interfaces:**
- Produces: `ProjectDetail.autoAcceptTerms: boolean`, `.autoAcceptExclusions: boolean`. Il Task 9 li legge.

- [ ] **Step 1: Scrivi il test che fallisce**

In coda al `describe("projectDetail")` di `app/test/project-detail.test.ts`:

```ts
  it("says what this book walks past without asking", () => {
    const db = seeded();
    db.prepare("UPDATE project SET auto_accept_exclusions = 0 WHERE id = 'p1'").run();

    // Not a setting of the application any more: the screen that edits it
    // needs to know what this book decided.
    expect(projectDetail(db, "p1")).toMatchObject({
      autoAcceptTerms: true,
      autoAcceptExclusions: false,
    });
  });
```

`seeded()` non nomina le due colonne nella sua `INSERT`, quindi il progetto nasce con il default `1` per entrambe: è esattamente ciò che il caso vuole verificare prima di spegnerne una.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/project-detail.test.ts`
Expected: FAIL — `autoAcceptTerms` è `undefined`.

- [ ] **Step 3: Aggiungi il campo al DTO**

In `app/shared/dto.ts`, dentro `ProjectDetail`, subito dopo `modelName`:

```ts
  /**
   * The two gates this book walks past without asking. A property of the
   * project since 015: the application no longer has an opinion about it.
   */
  autoAcceptTerms: boolean;
  autoAcceptExclusions: boolean;
```

- [ ] **Step 4: Leggile in `detail.ts`**

Nell'interfaccia di riga che il file dichiara, aggiungi:

```ts
  auto_accept_terms: number;
  auto_accept_exclusions: number;
```

Nella `SELECT`, accanto a `p.provider_id, p.model_id, p.created_at`, aggiungi
`p.auto_accept_terms, p.auto_accept_exclusions`.

Nella costruzione del DTO, accanto a `modelName: row.model_name`:

```ts
    autoAcceptTerms: row.auto_accept_terms === 1,
    autoAcceptExclusions: row.auto_accept_exclusions === 1,
```

- [ ] **Step 5: Esegui i test e verifica che passino**

Run: `npx vitest run app/test/project-detail.test.ts && npm run typecheck`
Expected: PASS. Se il typecheck segnala fixture di test del renderer che costruiscono un `ProjectDetail` letterale (`side.spec.ts`, `project.spec.ts`), aggiungi i due campi a quelle fixture con `true`.

- [ ] **Step 6: Commit**

```bash
git add app/main/projects/detail.ts app/shared/dto.ts app/test/project-detail.test.ts \
        app/renderer/src/app/project
git commit -m "feat(projects): il dettaglio dice quali gate questo libro attraversa da solo"
```

---

### Task 6: La corsa le legge dalla riga del progetto

Il cuore della modifica. Da qui la corsa non chiede più nulla alle impostazioni.

**Files:**
- Modify: `app/main/run/runtime.ts:20-25` (`RunRuntimeDeps`), `:27-40` (`ProjectRow`), `:82-100` (`project()` e `machineHost()`), `:384-394` (la `RunConfig`)
- Test: `app/test/run-runtime.test.ts`

**Interfaces:**
- Consumes: le due colonne (Task 1).
- Produces: `RunRuntimeDeps.settings(): { concurrency: number }`. Il Task 7 conta su questa firma ridotta.

- [ ] **Step 1: Scrivi il test che fallisce**

Il doppio del motore che il file già ha butta via ciò che gli viene mandato. Fagli tenere i comandi: in `fakeEngine()`, il `port` diventa

```ts
  const sent: unknown[] = [];
  const port: MessagePortLike = {
    // `makeEngineHost` sends every command down port1, so this is where the
    // start command — and the config the runtime built — actually goes.
    postMessage: (message) => { sent.push(message); },
    on: (_event, listener) => { receive = listener; },
    start: () => {},
    close: () => {},
  };
```

e il `return` di `fakeEngine()` guadagna `sent`:

```ts
  return {
    sent,
    emit(message: EngineMessage): void { … },
    crash(): void { … },
  };
```

`running()` cambia due cose — le impostazioni non hanno più un'opinione, e restituisce il motore come già fa:

```ts
  const runtime = makeRunRuntime({
    db,
    // The two gates used to be read from here. This object is now the whole of
    // what the runtime is allowed to ask the application.
    settings: () => ({ concurrency: 2 }),
    backendSpec: () => ({ kind: "fake" }),
    broadcast: () => {},
  });
```

Poi, in coda al file, il caso nuovo:

```ts
describe("where the runtime reads the two gates", () => {
  it("takes them off the project's row, and not off the settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "babelbook-run-gates-"));
    const db = openDatabase(":memory:");
    migrate(db, loadMigrations("app/main/db/migrations"));
    db.prepare(`
      INSERT INTO provider (id, name, route, headers, options)
      VALUES ('pv1', 'Acme', 'openai-compatible', '{}', '{}')
    `).run();
    db.prepare(`
      INSERT INTO provider_model (id, provider_id, model_id, display_name)
      VALUES ('pm1', 'pv1', 'm1', 'M1')
    `).run();

    const epubPath = join(dir, "book.epub");
    await writeFile(epubPath, await buildEpub({
      title: "The Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    }));
    const created = await createProject(db, dir, {
      epubPath, targetLanguage: "it", providerId: "pv1", modelId: "m1",
    });

    // One closed, one open: two booleans read from one place would both be
    // right by accident if the place were the wrong one.
    db.prepare(`
      UPDATE project SET auto_accept_terms = 0, auto_accept_exclusions = 1 WHERE id = ?
    `).run(created.id);

    const engine = fakeEngine();
    const runtime = makeRunRuntime({
      db,
      settings: () => ({ concurrency: 2 }),
      backendSpec: () => ({ kind: "fake" }),
      broadcast: () => {},
    });
    await runtime.start(created.id);

    const start = engine.sent.find((message) =>
      (message as { type?: string }).type === "start") as { config: RunConfig };
    expect(start.config).toMatchObject({ autoAcceptTerms: false, autoAcceptExclusions: true });
  });
});
```

Aggiungi `RunConfig` all'import dei tipi da `../shared/run.ts`.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/run-runtime.test.ts`
Expected: FAIL — `settings: () => ({ concurrency: 2 })` non compila contro la firma attuale, oppure la config riporta i valori delle impostazioni.

- [ ] **Step 3: Restringi la dipendenza e leggi dalla riga**

In `app/main/run/runtime.ts`:

```ts
export interface RunRuntimeDeps {
  db: DatabaseSync;
  /**
   * What is still an application-wide setting: how many requests go out at
   * once. The two gates used to be here and are now on the project's own row —
   * a book that stops to ask is a decision about that book.
   */
  settings(): { concurrency: number };
  /** The backend materials for a project, key included: they cross the engine port and no other. */
  backendSpec(projectId: string): BackendSpec;
  broadcast<K extends keyof Events>(channel: K, payload: Events[K]): void;
}
```

In `interface ProjectRow`, aggiungi:

```ts
  /** 0 or 1: SQLite has no boolean, and the row is read as it was written. */
  auto_accept_terms: number;
  auto_accept_exclusions: number;
```

Nella `SELECT` di `project()`, aggiungi `auto_accept_terms, auto_accept_exclusions` all'elenco.

`machineHost()` legge la riga invece delle impostazioni:

```ts
  const machineHost = (projectId: string, extra: Record<string, unknown> = {}) => {
    const row = project(projectId);
    return makeMachineHost(db, projectId, {
      autoAcceptTerms: row.auto_accept_terms === 1,
      autoAcceptExclusions: row.auto_accept_exclusions === 1,
      ...extra,
    });
  };
```

E nella costruzione della `RunConfig`, dove `row` è già in mano:

```ts
    const config: RunConfig = {
      projectId,
      cacheKey: key,
      sourceLanguage: row.source_language ?? "en",
      targetLanguage: row.target_language,
      autoAcceptTerms: row.auto_accept_terms === 1,
      autoAcceptExclusions: row.auto_accept_exclusions === 1,
      concurrency: settings.concurrency,
      contextWindowTokens,
    };
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npx vitest run app/test/run-runtime.test.ts app/test/run-compose.test.ts && npm run typecheck`
Expected: PASS. `main.ts` continua a passare `settings: () => readSettings(db)`: `Settings` ha ancora `concurrency`, e le proprietà in più non disturbano.

- [ ] **Step 5: Commit**

```bash
git add app/main/run/runtime.ts app/test/run-runtime.test.ts
git commit -m "feat(run): i due gate arrivano dal libro, non dalle impostazioni"
```

---

### Task 7: `Settings` perde i due campi, e le preferenze i due interruttori

Ora che nessuno li legge più, si tolgono. Non prima: toglierli con la corsa ancora in ascolto avrebbe spento due gate senza dirlo a nessuno.

**Files:**
- Modify: `app/shared/dto.ts:161-168` (`Settings`), `app/shared/channels.ts:20-28` (`DEFAULT_SETTINGS`)
- Modify: `app/main/ipc.ts:89-100` (`readSettings`)
- Modify: `app/renderer/src/app/settings/preferences.html:5-30`
- Test: `app/test/ipc.test.ts:130-145`, `app/renderer/src/app/settings/preferences.spec.ts`, `app/renderer/src/app/settings/settings.spec.ts:15`, `app/renderer/src/app/app.config.spec.ts:11`

- [ ] **Step 1: Togli i campi dal contratto**

In `app/shared/dto.ts`:

```ts
export interface Settings {
  uiLanguage: string;
  concurrency: number;
  epubcheckJar: string | null;
}
```

In `app/shared/channels.ts`, `DEFAULT_SETTINGS` perde le due righe, e il commento che le difendeva viene **riscritto, non cancellato**:

```ts
export const DEFAULT_SETTINGS: Settings = {
  uiLanguage: "it",
  // The two gates used to live here, closed by default, so that nobody spent
  // money on terminology they had never seen. They now live on the project,
  // open by default — and the reason is the same one: the choice is offered
  // where the book is created, in plain sight, instead of being made for
  // everybody in a screen nobody opens.
  concurrency: 2,
  epubcheckJar: null,
};
```

In `app/main/ipc.ts`, `readSettings` perde le due righe `autoAccept*`.

- [ ] **Step 2: Togli i due interruttori dalle preferenze**

In `app/renderer/src/app/settings/preferences.html`, cancella i due blocchi `<label class="prefs__check">` (righe 7-30). La sezione «Traduzione» resta con `concurrency`.

In `app/locales/it.json` e `app/locales/en.json`, togli da `prefs` le quattro chiavi `autoAcceptTerms`, `autoAcceptTermsHint`, `autoAcceptExclusions`, `autoAcceptExclusionsHint`: le stesse frasi vivono ora sotto `newProject`, aggiunte nel Task 4.

- [ ] **Step 3: Aggiorna i test che le nominavano**

- `app/test/ipc.test.ts:132` — l'oggetto atteso da `settings.get` diventa `{ uiLanguage: "it", concurrency: 2, epubcheckJar: null }`; le righe 140-142 che scrivono `autoAcceptTerms` diventano una scrittura di `concurrency`:

```ts
    const after = await handlers["settings.set"]({ concurrency: 4 });
    expect(after.concurrency).toBe(4);
```

- `app/renderer/src/app/settings/preferences.spec.ts` — togli i due campi dalla fixture (righe 12-13) e cancella i due casi che cliccano `auto-terms`/`auto-exclusions` (righe ~52-73). Aggiungi al loro posto:

```ts
  it("no longer decides for every book what a run walks past", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    // The choice moved onto the project. Leaving a global switch here would
    // mean two places claiming to own one fact.
    expect(fixture.nativeElement.querySelector("[data-testid=auto-terms]")).toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=auto-exclusions]")).toBeNull();
  });
```

- `app/renderer/src/app/settings/settings.spec.ts:15` e `app/renderer/src/app/app.config.spec.ts:11-12` — togli i due campi dalle fixture di `Settings`.

- [ ] **Step 4: Esegui tutto e verifica che passi**

Run: `npx vitest run app/test && npm run test:ui -w app && npm run typecheck`
Expected: PASS. Il typecheck è il vero controllo: `Settings` è importato in main, preload e renderer, e un residuo non compila.

- [ ] **Step 5: Commit**

```bash
git add app/shared/dto.ts app/shared/channels.ts app/main/ipc.ts \
        app/renderer/src/app/settings app/renderer/src/app/app.config.spec.ts \
        app/locales/it.json app/locales/en.json app/test/ipc.test.ts
git commit -m "refactor(settings): le due auto-accettazioni non sono più dell'applicazione"
```

---

### Task 8: La libreria spegne «Nuovo progetto»

La prima porta: chi non ha con cosa tradurre non viene portato in un modulo che non può finire.

**Files:**
- Modify: `app/renderer/src/app/library/library.ts`, `library.html:11`, `library.css`
- Modify: `app/locales/it.json`, `app/locales/en.json`
- Test: `app/renderer/src/app/library/library.spec.ts`

- [ ] **Step 1: Scrivi i test che falliscono**

Prima, nel `bridge()` di `library.spec.ts`, aggiungi la risposta di default — senza di essa i casi esistenti riceverebbero `undefined` dal canale nuovo:

```ts
    if (channel === "providers.list") {
      return [{
        id: "pv1", name: "Acme", route: "acme", baseUrl: null, headers: {}, options: {},
        catalogId: null, catalogAt: null, hasKey: true,
        models: [{ id: "m1", displayName: "M1", contextWindow: null, priceIn: null,
                   priceOut: null, capabilities: null, reasoningLevel: null }],
      }];
    }
```

Poi, in coda al `describe("Library")`:

```ts
  it("will not send anyone to a form they cannot finish", async () => {
    const { fixture } = mount({ "providers.list": [] });
    await fixture.whenStable();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector("[data-testid=new-project]");
    expect(button.hasAttribute("disabled")).toBe(true);
    // Spelled out, and with the way to fix it: a dead button that explains
    // nothing is a bug report waiting to be filed.
    expect(fixture.nativeElement.querySelector("[data-testid=needs-provider]")).not.toBeNull();
  });

  it("does not count a provider that serves no model", async () => {
    const noModels = [{
      id: "pv1", name: "Acme", route: "acme", baseUrl: null, headers: {}, options: {},
      catalogId: null, catalogAt: null, hasKey: true, models: [],
    }];
    const { fixture } = mount({ "providers.list": noModels });
    await fixture.whenStable();
    fixture.detectChanges();

    // The form asks for a model too. A provider with none makes it just as
    // impossible to finish as no provider at all.
    expect(fixture.nativeElement.querySelector("[data-testid=new-project]").hasAttribute("disabled"))
      .toBe(true);
  });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npm run test:ui -w app`
Expected: FAIL — i due nuovi.

- [ ] **Step 3: Il componente**

In `app/renderer/src/app/library/library.ts`, aggiungi `computed` all'import da `@angular/core` e `Provider` all'import dei tipi, poi:

```ts
  readonly providers = signal<Provider[]>([]);

  /**
   * Whether anything here could translate a book.
   *
   * A provider with no models does not count: the new-project form asks for a
   * model as well, so an enabled button would open a form nobody can finish.
   */
  readonly canCreate = computed(() =>
    this.providers().some((provider) => provider.models.length > 0));
```

Nel costruttore, accanto agli altri ascolti:

```ts
    void this.#loadProviders();
    // A provider connected in the settings must light this button back up
    // without a restart.
    this.#unsubscribe.push(this.#ipc.on("providers.changed", () => void this.#loadProviders()));
```

e il metodo:

```ts
  async #loadProviders(): Promise<void> {
    this.providers.set(await this.#ipc.invoke("providers.list", undefined));
  }
```

- [ ] **Step 4: Il template**

In `app/renderer/src/app/library/library.html`, sostituisci la riga 11 con:

```html
    @if (canCreate()) {
      <a class="btn btn-primary" data-testid="new-project" routerLink="/new">{{ t('library.newProject') }}</a>
    } @else {
      <button type="button" class="btn btn-primary" data-testid="new-project" disabled>
        {{ t('library.newProject') }}
      </button>
    }
  </header>

  @if (!canCreate()) {
    <p class="library__needsProvider" data-testid="needs-provider">
      {{ t('library.needsProvider') }}
      <a routerLink="/settings/providers">{{ t('library.toProviders') }}</a>
    </p>
  }
```

(La riga `</header>` esisteva già subito sotto: non duplicarla.)

In `library.css`, `.library__needsProvider` prende la stessa spaziatura di `.library__empty` — copiane le proprietà, senza colori nuovi.

- [ ] **Step 5: Le stringhe**

`app/locales/it.json`, dentro `library`:

```json
    "needsProvider": "Per tradurre un libro serve un provider. Non ne hai ancora configurato uno.",
    "toProviders": "Vai ai provider",
```

`app/locales/en.json`, dentro `library`:

```json
    "needsProvider": "Translating a book takes a provider. You have not configured one yet.",
    "toProviders": "Go to providers",
```

- [ ] **Step 6: Esegui i test e verifica che passino**

Run: `npm run test:ui -w app && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/renderer/src/app/library app/locales/it.json app/locales/en.json
git commit -m "feat(library): il bottone si spegne quando non c'è niente con cui tradurre"
```

---

### Task 9: La schermata di modifica, e la conferma `contractChange`

La prima volta che un progetto si può cambiare dopo averlo creato.

**Files:**
- Create: `app/renderer/src/app/core/languages.ts`
- Create: `app/renderer/src/app/project/side/project-settings.ts`, `project-settings.html`
- Modify: `app/renderer/src/app/new-project/new-project.ts` (importa le lingue invece di dichiararle)
- Modify: `app/renderer/src/app/project/side/side.ts`, `side.html`, `side.css`
- Modify: `app/shared/channels.ts:41` (`CONFIRM_KINDS`), `app/main/ipc.ts:206-212` (il verbo della conferma)
- Modify: `app/locales/it.json`, `app/locales/en.json`
- Test: `app/renderer/src/app/project/side/side.spec.ts`, nuovo `project-settings.spec.ts`

**Interfaces:**
- Consumes: `ProjectDetail.autoAccept*` (Task 5), `UpdateProjectRequest.autoAccept*` (Task 3).
- Produces: `ConfirmKind` `"contractChange"`, con `detail: { title, done }`.

- [ ] **Step 1: Estrai le lingue, che ora servono a due schermate**

`app/renderer/src/app/core/languages.ts`:

```ts
/**
 * The languages a book can be translated into.
 *
 * Declared once because two screens offer them — the one that creates a
 * project and the one that edits it — and a list that drifted between the two
 * would let a project be created in a language it could never be edited back to.
 */
export const TARGET_LANGUAGES = ["it", "en", "fr", "de", "es", "pt"] as const;
```

In `app/renderer/src/app/new-project/new-project.ts`, cancella la costante locale e importa questa:

```ts
import { TARGET_LANGUAGES } from "../core/languages";
```

- [ ] **Step 2: Scrivi i test che falliscono**

`app/renderer/src/app/project/side/project-settings.spec.ts`:

```ts
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import type { ProjectDetail, Provider } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { provideI18n } from "../../core/i18n";
import { ProjectSettings } from "./project-settings";

const provider: Provider = {
  id: "pv1", name: "Acme", route: "acme", baseUrl: null, headers: {}, options: {},
  catalogId: null, catalogAt: null, hasKey: true,
  models: [
    { id: "m1", displayName: "M1", contextWindow: null, priceIn: null, priceOut: null,
      capabilities: null, reasoningLevel: null },
    { id: "m2", displayName: "M2", contextWindow: null, priceIn: null, priceOut: null,
      capabilities: null, reasoningLevel: null },
  ],
};

const detail = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1", title: "A Book", coverPath: null, sourceLanguage: "en", targetLanguage: "it",
  state: "ready", progress: { done: 0, total: 10 }, layout: "reflowable",
  createdAt: "2026-08-31T00:00:00.000Z", outputPath: null,
  description: null, hasOverlays: false,
  providerId: "pv1", modelId: "m1", providerName: "Acme", modelName: "M1",
  autoAcceptTerms: true, autoAcceptExclusions: true,
  actions: [], tokens: { in: 0, out: 0, reasoning: 0 }, cost: null,
  runStartedAt: null, runEndedAt: null, phases: [], finishedAt: null,
  ...over,
});

function mount(project = detail(), answers: Record<string, unknown> = {}) {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel in answers) {
      const answer = answers[channel];
      return typeof answer === "function" ? answer(payload) : answer;
    }
    if (channel === "providers.list") return [provider];
    if (channel === "ui.confirm") return { confirmed: true };
    return undefined;
  });
  TestBed.configureTestingModule({
    imports: [ProjectSettings],
    providers: [...provideI18n("it"), { provide: IpcService, useValue: { invoke, on: () => () => {} } }],
  });
  const fixture = TestBed.createComponent(ProjectSettings);
  fixture.componentRef.setInput("project", project);
  return { fixture, invoke };
}

const calls = (invoke: ReturnType<typeof vi.fn>, channel: string) =>
  invoke.mock.calls.filter(([name]: unknown[]) => name === channel);

describe("ProjectSettings", () => {
  it("saves the whole form in one call", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    fixture.componentInstance.autoAcceptTerms.set(false);
    fixture.componentInstance.description.set("A note");
    await fixture.componentInstance.save();

    expect(calls(invoke, "project.update")[0]![1]).toMatchObject({
      id: "p1", providerId: "pv1", modelId: "m1",
      autoAcceptTerms: false, autoAcceptExclusions: true, description: "A note",
    });
  });

  it("asks before a change that stops the work already paid for from counting", async () => {
    const { fixture, invoke } = mount(detail({ progress: { done: 7, total: 10 } }));
    await fixture.whenStable();

    fixture.componentInstance.pickModel("m2");
    await fixture.componentInstance.save();

    expect(calls(invoke, "ui.confirm")[0]![1])
      .toMatchObject({ kind: "contractChange", detail: { title: "A Book", done: 7 } });
  });

  it("does not ask when there is nothing to lose", async () => {
    const { fixture, invoke } = mount(detail({ progress: { done: 0, total: 10 } }));
    await fixture.whenStable();

    fixture.componentInstance.pickModel("m2");
    await fixture.componentInstance.save();

    // A question with no stake teaches people to click through questions
    // that have one.
    expect(calls(invoke, "ui.confirm")).toHaveLength(0);
    expect(calls(invoke, "project.update")).toHaveLength(1);
  });

  it("does not ask when only the endpoint changes", async () => {
    const other: Provider = { ...provider, id: "pv2", name: "Other" };
    const { fixture, invoke } = mount(
      detail({ progress: { done: 7, total: 10 } }),
      { "providers.list": [provider, other] },
    );
    await fixture.whenStable();

    // The cache key is made of the model, not of who serves it: the same model
    // reached through another endpoint is the same work.
    fixture.componentInstance.pickProvider("pv2");
    fixture.componentInstance.pickModel("m1");
    await fixture.componentInstance.save();

    expect(calls(invoke, "ui.confirm")).toHaveLength(0);
  });

  it("keeps the row as it was when the question is answered no", async () => {
    const { fixture, invoke } = mount(
      detail({ progress: { done: 7, total: 10 } }),
      { "ui.confirm": { confirmed: false } },
    );
    await fixture.whenStable();

    fixture.componentInstance.pickModel("m2");
    await fixture.componentInstance.save();

    expect(calls(invoke, "project.update")).toHaveLength(0);
  });
});
```

E in `app/renderer/src/app/project/side/side.spec.ts`, in coda:

```ts
  it("offers the edit, and refuses it only while the engine is alive", () => {
    // Paused is exactly when someone changes their mind about the model, so
    // the button stays on. What protects the work is the confirmation inside
    // the dialog, not a button that is off.
    const paused = mount({ ...detail, state: "paused" });
    expect(paused.fixture.nativeElement.querySelector("[data-testid=side-edit]")
      .hasAttribute("disabled")).toBe(false);

    const running = mount({ ...detail, state: "running" });
    expect(running.fixture.nativeElement.querySelector("[data-testid=side-edit]")
      .hasAttribute("disabled")).toBe(true);
  });
```

`mount(project = detail)` prende un `ProjectDetail` intero e chiama già `detectChanges()`; `resetTestingModule()` in testa gli permette due montaggi nello stesso caso.

- [ ] **Step 3: Esegui i test e verifica che falliscano**

Run: `npm run test:ui -w app`
Expected: FAIL — `./project-settings` non esiste.

- [ ] **Step 4: Il componente**

`app/renderer/src/app/project/side/project-settings.ts`:

```ts
import {
  ChangeDetectionStrategy, Component, computed, inject, input, output, signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective } from "@jsverse/transloco";
import type { ProjectDetail, Provider } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { TARGET_LANGUAGES } from "../../core/languages";
import { Detail } from "../detail";

/**
 * A project, after it was created.
 *
 * Until this existed a book's provider could only be chosen on the way in, and
 * a provider chosen once was a provider forever. The dialog is the same modal
 * shell the column already uses for the description: one guest at a time in
 * front of the work, not a second screen.
 *
 * It asks the main process for exactly one thing — the provider list — because
 * the project itself arrives already loaded from the column above it.
 */
@Component({
  selector: "bb-project-settings",
  standalone: true,
  imports: [Detail, FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./project-settings.html",
})
export class ProjectSettings {
  readonly project = input.required<ProjectDetail>();
  readonly closed = output<void>();

  readonly languages = TARGET_LANGUAGES;

  readonly providers = signal<Provider[]>([]);
  readonly providerId = signal<string | null>(null);
  readonly modelId = signal<string | null>(null);
  readonly targetLanguage = signal("it");
  readonly sourceLanguage = signal("");
  readonly description = signal("");
  readonly autoAcceptTerms = signal(true);
  readonly autoAcceptExclusions = signal(true);
  readonly saving = signal(false);

  readonly usable = computed(() =>
    this.providers().filter((provider) => provider.models.length > 0));

  readonly chosenProvider = computed(() =>
    this.providers().find((provider) => provider.id === this.providerId()) ?? null);

  readonly canSave = computed(() => this.providerId() !== null && this.modelId() !== null);

  /**
   * Whether this form changes what the stored translations were made under.
   *
   * `projectCacheKey` digests the model and both languages; the provider is
   * not in it, because the key names the model and not who served it. Change
   * any of the three and the work already paid for stays on the disk and
   * stops counting — which is the question the confirmation asks.
   */
  readonly contractChanged = computed(() => {
    const found = this.project();
    const source = this.sourceLanguage() === "" ? null : this.sourceLanguage();
    return this.modelId() !== found.modelId
      || this.targetLanguage() !== found.targetLanguage
      || source !== found.sourceLanguage;
  });

  #ipc = inject(IpcService);

  constructor() {
    void this.#load();
  }

  async #load(): Promise<void> {
    const found = this.project();
    this.providers.set(await this.#ipc.invoke("providers.list", undefined));
    this.providerId.set(found.providerId);
    this.modelId.set(found.modelId);
    this.targetLanguage.set(found.targetLanguage);
    this.sourceLanguage.set(found.sourceLanguage ?? "");
    this.description.set(found.description ?? "");
    this.autoAcceptTerms.set(found.autoAcceptTerms);
    this.autoAcceptExclusions.set(found.autoAcceptExclusions);
  }

  /** Choosing a provider takes its first model along, as the form's best guess. */
  pickProvider(id: string): void {
    this.providerId.set(id);
    this.modelId.set(this.providers().find((provider) => provider.id === id)?.models[0]?.id ?? null);
  }

  pickModel(id: string): void {
    this.modelId.set(id);
  }

  async save(): Promise<void> {
    const found = this.project();
    const providerId = this.providerId();
    const modelId = this.modelId();
    if (providerId === null || modelId === null) return;

    // Only when there is something to lose. A question with no stake teaches
    // people to click through the questions that have one.
    if (this.contractChanged() && found.progress.done > 0) {
      const { confirmed } = await this.#ipc.invoke("ui.confirm", {
        kind: "contractChange",
        detail: { title: found.title, done: found.progress.done },
      });
      if (!confirmed) return;
    }

    this.saving.set(true);
    try {
      await this.#ipc.invoke("project.update", {
        id: found.id,
        providerId,
        modelId,
        targetLanguage: this.targetLanguage(),
        sourceLanguage: this.sourceLanguage() === "" ? null : this.sourceLanguage(),
        description: this.description(),
        autoAcceptTerms: this.autoAcceptTerms(),
        autoAcceptExclusions: this.autoAcceptExclusions(),
      });
    } finally {
      this.saving.set(false);
    }
    // The reload arrives on its own: the main process broadcasts
    // `project.changed`, and the screen above is already listening.
    this.closed.emit();
  }
}
```

`app/renderer/src/app/project/side/project-settings.html`:

```html
<bb-detail [title]="t('project.editTitle')" (closed)="closed.emit()" *transloco="let t">
  <div class="detail__form">
    <label>
      {{ t('newProject.provider') }}
      <select class="select" data-testid="edit-provider" [ngModel]="providerId()"
              (ngModelChange)="pickProvider($event)">
        @for (provider of usable(); track provider.id) {
          <option [value]="provider.id">{{ provider.name }}</option>
        }
      </select>
    </label>

    @if (chosenProvider(); as provider) {
      <label>
        {{ t('newProject.model') }}
        <select class="select" data-testid="edit-model" [ngModel]="modelId()"
                (ngModelChange)="pickModel($event)">
          @for (model of provider.models; track model.id) {
            <option [value]="model.id">{{ model.displayName }}</option>
          }
        </select>
      </label>
    }

    <label>
      {{ t('newProject.targetLanguage') }}
      <select class="select" data-testid="edit-target-language" [ngModel]="targetLanguage()"
              (ngModelChange)="targetLanguage.set($event)">
        @for (language of languages; track language) {
          <option [value]="language">{{ language }}</option>
        }
      </select>
    </label>

    <label>
      {{ t('newProject.sourceLanguage') }}
      <input class="input" data-testid="edit-source-language" [ngModel]="sourceLanguage()"
             (ngModelChange)="sourceLanguage.set($event)" />
    </label>

    <label>
      {{ t('newProject.description') }}
      <textarea class="textarea" data-testid="edit-description" rows="3" [ngModel]="description()"
                (ngModelChange)="description.set($event)"></textarea>
      <small>{{ t('newProject.descriptionHint') }}</small>
    </label>

    <label class="prefs__check">
      <input type="checkbox" class="checkbox" data-testid="edit-auto-terms"
             [ngModel]="autoAcceptTerms()" (ngModelChange)="autoAcceptTerms.set($event)" />
      <span>
        {{ t('newProject.autoAcceptTerms') }}
        <small>{{ t('newProject.autoAcceptTermsHint') }}</small>
      </span>
    </label>

    <label class="prefs__check">
      <input type="checkbox" class="checkbox" data-testid="edit-auto-exclusions"
             [ngModel]="autoAcceptExclusions()" (ngModelChange)="autoAcceptExclusions.set($event)" />
      <span>
        {{ t('newProject.autoAcceptExclusions') }}
        <small>{{ t('newProject.autoAcceptExclusionsHint') }}</small>
      </span>
    </label>
  </div>

  <ng-container detail-actions>
    <button type="button" class="btn btn-primary" data-testid="edit-save"
            [disabled]="!canSave() || saving()" (click)="save()">
      {{ t('project.editSave') }}
    </button>
  </ng-container>
</bb-detail>
```

**Attenzione:** `bb-detail` proietta le azioni con `select="[detail-actions]"`. Se il guscio non accetta un `<ng-container detail-actions>`, usa un `<div detail-actions>` — leggi `detail.html` prima di scrivere.

`.detail__form` e `.prefs__check` vanno aggiunte a `side.css` copiando la spaziatura già usata da `.detail__text` e dalla casella delle preferenze, **senza colori nuovi**.

- [ ] **Step 5: Il bottone nella colonna**

In `app/renderer/src/app/project/side/side.ts`: importa `ProjectSettings` e aggiungilo agli `imports` del componente, poi:

```ts
  /** Whether the edit dialog is open. */
  readonly editOpen = signal(false);

  /**
   * Editing is refused only while the engine is actually alive.
   *
   * A suspended run — paused, or stopped at a gate — is exactly when someone
   * changes their mind about the model, so the button stays on there. What
   * protects the work already done is the confirmation inside the dialog, not
   * a button that is off.
   */
  canEdit(): boolean {
    const state = this.project().state;
    return state !== "running" && state !== "composing";
  }
```

In `side.html`, subito dopo la `</dl>` dei fatti:

```html
    <div class="side__edit">
      <button type="button" class="btn btn-xs" data-testid="side-edit"
              [disabled]="!canEdit()" (click)="editOpen.set(true)">
        {{ t('project.edit') }}
      </button>
    </div>
```

e accanto al dialogo della descrizione, in fondo:

```html
    @if (editOpen()) {
      <bb-project-settings [project]="found" (closed)="editOpen.set(false)" />
    }
```

- [ ] **Step 6: La conferma**

In `app/shared/channels.ts`, `CONFIRM_KINDS` guadagna `"contractChange"`:

```ts
export const CONFIRM_KINDS = [
  "deleteProject", "deleteProvider", "deleteGlossary", "abandonProject", "reasoningChange",
  "contractChange",
] as const;
```

In `app/main/ipc.ts`, dentro `confirmQuestion`, il verbo:

```ts
    verify: t(
      kind === "abandonProject" ? "confirm.abandon"
      : kind === "deleteProvider" ? "confirm.disconnect"
      : kind === "reasoningChange" || kind === "contractChange" ? "confirm.apply"
      : "confirm.delete",
    ),
```

`app/locales/it.json`, dentro `confirm`:

```json
    "contractChange": {
      "message": "Cambiare modello o lingua di «{{title}}»? Le {{done}} unità già tradotte erano legate alla configurazione precedente: restano sul disco, ma smetteranno di contare."
    },
```

e dentro `project`:

```json
    "edit": "Modifica",
    "editTitle": "Impostazioni del progetto",
    "editSave": "Salva",
```

`app/locales/en.json`, dentro `confirm`:

```json
    "contractChange": {
      "message": "Change the model or a language of “{{title}}”? The {{done}} units already translated were tied to the previous configuration: they stay on disk, but they will stop counting."
    },
```

e dentro `project`:

```json
    "edit": "Edit",
    "editTitle": "Project settings",
    "editSave": "Save",
```

- [ ] **Step 7: Esegui i test e verifica che passino**

Run: `npm run test:ui -w app && npx vitest run app/test && npm run typecheck`
Expected: PASS. `app/test/ipc.test.ts` ha un caso che confronta le chiavi degli handler con `INVOCATIONS`: le conferme non sono canali, quindi non cambia. Se un test del catalogo verifica che ogni `ConfirmKind` abbia una frase in entrambe le lingue, il nuovo la ha.

- [ ] **Step 8: Commit**

```bash
git add app/renderer/src/app/core/languages.ts app/renderer/src/app/project/side \
        app/renderer/src/app/new-project/new-project.ts \
        app/shared/channels.ts app/main/ipc.ts app/locales/it.json app/locales/en.json
git commit -m "feat(project): un progetto si può modificare, e il cambio di contratto si dichiara"
```

---

### Task 10: Le prove end-to-end, e la passata finale

Sei spec aprono l'applicazione su un profilo vuoto e creano un progetto. Da questo piano in poi, un profilo vuoto non ha provider e quel bottone è spento.

**Files:**
- Modify: `app/e2e/support.ts`
- Modify: `app/e2e/create-project.spec.ts`, `gates.spec.ts`, `translate.spec.ts`, `screens.spec.ts`, `live.spec.ts`, `packaged.spec.ts`, `settings.spec.ts`
- Modify: `docs/superpowers/STATO.md`

- [ ] **Step 1: Il seme, nel supporto**

In coda a `app/e2e/support.ts`:

```ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";

/**
 * One provider and one model, written into the database the application is
 * about to open.
 *
 * A project cannot be created without a provider any more. Driving the
 * provider screen in every spec would test that screen six times and the
 * thing under test once — and the specs that mean to test it already do.
 *
 * The rows go in through the application's own migrations, against the path
 * the application itself will open, so a schema change breaks this too. That
 * is the point: a fixture that outlives the schema is a fixture that lies.
 */
export async function seedProvider(userData: string): Promise<void> {
  await mkdir(userData, { recursive: true });
  const db = openDatabase(join(userData, "babelbook.db"));
  migrate(db, loadMigrations(join(import.meta.dirname, "../main/db/migrations")));
  db.prepare(`
    INSERT INTO provider (id, name, route, base_url, headers, options)
    VALUES ('e2e-provider', 'End To End', 'openai-compatible', 'http://127.0.0.1:1', '{}', '{}')
  `).run();
  db.prepare(`
    INSERT INTO provider_model (id, provider_id, model_id, display_name,
                                context_window, price_in, price_out)
    VALUES ('e2e-model', 'e2e-provider', 'e2e-model-1', 'E2E Model', 128000, 1, 5)
  `).run();
  db.close();
}
```

- [ ] **Step 2: Semina prima di ogni lancio**

In `create-project.spec.ts`, `gates.spec.ts`, `translate.spec.ts`, `screens.spec.ts`, `live.spec.ts` e `packaged.spec.ts`: importa `seedProvider` da `./support.ts` e chiamalo con la stessa directory passata a `BABELBOOK_USER_DATA`, **prima** di `electron.launch`. In `create-project.spec.ts` il posto è dentro `launch()`, subito prima della `electron.launch`:

```ts
async function launch(userData: string, epub: string) {
  await seedProvider(userData);
  const app = await electron.launch({ … });
  return { app, window: await mainWindow(app) };
}
```

Negli altri file la `electron.launch` è inline nel test: metti la chiamata sulla riga precedente.

`splash.spec.ts` e `providers.spec.ts` **non** si toccano: il primo non crea progetti, il secondo prova proprio la schermata dei provider e deve partire da vuoto.

- [ ] **Step 3: `live.spec.ts` smette di accendere ciò che è già acceso**

Cancella le quattro righe che aprivano i gate dalle preferenze (`live.spec.ts:51-54`, da `nav-translation` a `nav-all`) e il commento sopra. Sostituiscilo con:

```ts
  // Both gates are accepted without asking — that is now the default a new
  // project is born with — because this check is about a list keeping up with
  // a run, and a gate stops the run and moves the tab away from it.
```

- [ ] **Step 4: `gates.spec.ts` dice a voce ciò che dava per scontato**

La spec attraversa i due gate a mano e finora si appoggiava al default globale. Ora li spegne dove si decidono, in `/new`, prima di creare. Sostituisci il commento di riga 79 e aggiungi i due clic subito prima del `create`:

```ts
  // The default is now to walk past both gates, so this spec says out loud
  // what it needs: they are closed here, on this book, and nowhere else.
  await window.getByTestId("auto-terms").uncheck();
  await window.getByTestId("auto-exclusions").uncheck();
  await window.getByTestId("create").click();
```

e il commento «Both gates are on by default, so the run stops and asks» diventa:

```ts
  // Both gates were closed on the form, so the run stops and asks. A gate that
```

Fai lo stesso nel secondo test del file, quello che dichiara di andare «straight through both gates»: lì i due gate vanno lasciati aperti, quindi **non** aggiungere i clic — verifica soltanto che il commento resti vero.

- [ ] **Step 5: `settings.spec.ts` prova un'impostazione che esiste ancora**

Alle righe 57-62, il blocco che accendeva `auto-terms` diventa:

```ts
  // A setting changed is a decision, and it has to persist.
  await window.getByTestId("nav-translation").click();
  await window.getByTestId("concurrency").fill("4");
  await expect.poll(async () => window.evaluate(() =>
    (window as unknown as { babelbook: Bridge }).babelbook.invoke("settings.get", undefined)))
    .toMatchObject({ concurrency: 4 });
```

Il resto del test — le quattro sezioni, il glossario, la lingua che cambia e sopravvive alla chiusura — non si tocca. `settings.spec.ts` **non** riceve `seedProvider`: non crea progetti, e la schermata dei provider deve poter partire vuota.

- [ ] **Step 6: Esegui tutto**

```bash
npm run typecheck
npm test
npm run test:ui -w app
npm run build -w app
npm run test:e2e -w app
```

Expected: unit e componenti verdi; le e2e rosse devono essere **esattamente quelle annotate all'inizio del piano**, non una di più. Se ne compare una nuova, è questo piano ad averla rotta: non chiuderlo.

- [ ] **Step 7: Rigenera e guarda gli screenshot**

```bash
npm run test:e2e -w app -- e2e/screens.spec.ts
```

Apri le immagini prodotte. La libreria, `/new` e la colonna di destra sono tutte cambiate: se una casella sborda, se il bottone «Modifica» finisce sopra i fatti, o se la riga del provider mancante non si legge, si aggiusta il CSS **qui**, con i token di `styles.css`.

- [ ] **Step 8: Aggiorna `STATO.md`**

Nella tabella «Dove siamo» aggiungi una riga:

```
| Provider obbligatorio e auto-accettazione per progetto | **completo** | `app/main/projects/`, `app/renderer/src/app/project/side/` |
```

e nel corpo, sotto la suite, una frase che dice il fatto che nessun piano ricorderebbe da solo: **il default dei due gate è ribaltato, ed è per progetto**. Aggiorna il numero dei test.

- [ ] **Step 9: Commit**

```bash
git add app/e2e docs/superpowers/STATO.md app/renderer/src/app
git commit -m "test(e2e): le prove seminano un provider, e i gate si chiudono sul libro"
```

---

## Note per chi esegue

- **L'ordine dei task non è negoziabile.** Il Task 2 rompe di proposito `new-project.ts`, e il Task 4 lo ripara; il Task 7 toglie i due campi da `Settings` solo dopo che il Task 6 ha smesso di leggerli. Invertirne due significa spegnere due gate senza dirlo a nessuno.
- **Dove piano e codice divergono, vince il codice.** I numeri di riga sono di oggi e si spostano al primo commit. Cerca per nome, non per riga.
- **Non aggiungere `NOT NULL` a `provider_id`.** È scritto nel commento della migrazione e nella spec, ed è la cosa che verrà proposta per prima da chiunque legga solo lo schema.
