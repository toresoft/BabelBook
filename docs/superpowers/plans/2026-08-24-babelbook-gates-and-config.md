# babelBook — Piano 5: i gate, i glossari e il report

**Stato: non iniziato**, al 2026-08-25. Dipende dal piano 4, che è a metà.

Attenzione a due punti che il resto del lavoro ha già cambiato sotto questo piano:
le regole terminologiche sono **tre** (`dnt`, `prefer`, `must`) e i termini portano
anche un campo `sense`; e i canali IPC si dichiarano in `app/shared/channels.ts`
con il gestore nella mappa di `buildHandlers`, che un test confronta con l'elenco.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dare all'utente il controllo che la spec promette — approvare i termini, rivedere ciò che non verrà tradotto, ispezionare le unità, leggere il report, curare i glossari — e chiudere la localizzazione.

**Architecture:** nessuna logica nuova nel motore. Questo piano aggiunge letture, scritture mirate e schermate: i due gate diventano schermi con cui si sblocca la macchina a stati del piano 4, e la modifica di un termine invalida solo le unità che lo contengono.

**Tech Stack:** Angular 22 con signal, Transloco, `node:sqlite`, i moduli `terms.ts` e `glossary/` del piano 2.

**Spec:** `docs/superpowers/specs/2026-08-24-babelbook-design.md`
**Piani precedenti:** 1, 2, 3, 4 — tutti obbligatori.

## Global Constraints

- **Node 24.18.x**: `export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`
- **Nessuna stringa rivolta all'utente nei componenti**: tutto dai cataloghi in `app/locales/`. I codici del core diventano chiavi.
- **Nessuna logica di dominio nel renderer.** Le decisioni stanno nel main o nel core; la finestra chiede e mostra.
- **Ogni azione che invalida traduzioni dichiara quante** prima di eseguirla.
- **Codice e commenti in inglese**, documenti in italiano.
- **Commit a ogni task.**

## Struttura dei file

```
app/
  main/
    terms/approve.ts        approvazione, modifica, promozione al glossario
    terms/invalidate.ts     quali unità perdono la traduzione, e la cancellazione
    exclusions/review.ts    forzatura dello stato di una unità nei due sensi
    glossaries/store.ts     CRUD, import ed export in markdown
    report/build.ts         il report di un run, per codici
  renderer/src/app/
    project/project.component.ts        intestazione e schede
    project/terms/terms.component.ts
    project/exclusions/exclusions.component.ts
    project/units/units.component.ts
    project/report/report.component.ts
    settings/settings.component.ts
    settings/glossaries.component.ts
  locales/it.json, en.json
```

---

### Task 1: Approvazione dei termini

**Files:**
- Create: `app/main/terms/approve.ts`, `app/test/terms-approve.test.ts`
- Modify: `app/shared/channels.ts`, `app/main/ipc.ts`

**Interfaces:**

```ts
export interface TermRow {
  id: string; source: string; target: string | null;
  rule: "dnt" | "must"; origin: "glossary" | "extracted" | "manual";
  approval: "pending" | "approved" | "rejected";
  occurrences: number; context: string | null; note: string | null;
}
export function listTerms(db: DatabaseSync, projectId: string): TermRow[];
export function decideTerms(db: DatabaseSync, projectId: string, decisions: Array<{
  id: string; approval: "approved" | "rejected"; target?: string | null; rule?: "dnt" | "must"; note?: string;
}>): { approved: number; rejected: number };
export function addManualTerm(db: DatabaseSync, projectId: string, term: Omit<TermRow, "id" | "origin" | "approval" | "occurrences" | "context">): TermRow;
export function promoteToGlossary(db: DatabaseSync, termId: string, glossaryId: string): { version: number };
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/terms-approve.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { addManualTerm, decideTerms, listTerms, promoteToGlossary } from "../main/terms/approve.ts";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
    + "VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','waiting-terms')").run();
  db.prepare("INSERT INTO term (id, project_id, source, target, rule, origin, approval_state) "
    + "VALUES ('t1','p1','Rivendell',NULL,'dnt','extracted','pending')").run();
  db.prepare("INSERT INTO term (id, project_id, source, target, rule, origin, approval_state) "
    + "VALUES ('t2','p1','dwarf','nano','must','extracted','pending')").run();
  db.prepare("INSERT INTO glossary (id, name, description, source_language, target_language, version) "
    + "VALUES ('g1','fantasy','Epic fantasy','en','it',1)").run();
  return db;
}

describe("terms", () => {
  it("lists what is pending", () => {
    expect(listTerms(seeded(), "p1").filter((t) => t.approval === "pending")).toHaveLength(2);
  });

  it("records a decision and the edited rendering together", () => {
    const db = seeded();
    const counts = decideTerms(db, "p1", [
      { id: "t1", approval: "approved" },
      { id: "t2", approval: "approved", target: "nanerottolo" },
    ]);
    expect(counts).toEqual({ approved: 2, rejected: 0 });
    expect(listTerms(db, "p1").find((t) => t.id === "t2")?.target).toBe("nanerottolo");
  });

  it("keeps a rejected term instead of deleting it, so it is not proposed again", () => {
    const db = seeded();
    decideTerms(db, "p1", [{ id: "t1", approval: "rejected" }]);
    expect(listTerms(db, "p1").find((t) => t.id === "t1")?.approval).toBe("rejected");
  });

  it("accepts a term the user typed, already approved", () => {
    const db = seeded();
    const term = addManualTerm(db, "p1", { source: "Bag End", target: null, rule: "dnt", note: null });
    expect(term).toMatchObject({ origin: "manual", approval: "approved" });
  });

  it("bumps the glossary version when a term is promoted into it", () => {
    const db = seeded();
    decideTerms(db, "p1", [{ id: "t1", approval: "approved" }]);
    expect(promoteToGlossary(db, "t1", "g1").version).toBe(2);
    const rows = db.prepare("SELECT count(*) AS n FROM glossary_term WHERE glossary_id='g1'").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("refuses to promote a term nobody approved", () => {
    const db = seeded();
    expect(() => promoteToGlossary(db, "t2", "g1")).toThrow(/NOT_APPROVED/);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/terms-approve.test.ts`
Atteso: FAIL, `Cannot find module '../main/terms/approve.ts'`.

- [ ] **Step 3: Implementare**

1. Un termine rifiutato **resta in tabella** con `approval: "rejected"`: cancellarlo lo farebbe riproporre dalla prossima analisi, e l'utente rifiuterebbe di nuovo la stessa cosa.
2. Un termine scritto a mano nasce già approvato: l'utente lo ha appena deciso, chiedergli di approvarlo sarebbe una domanda a cui ha già risposto.
3. **Promuovere alza la versione del glossario.** La versione entra nella chiave di cache del piano 2, quindi un glossario cresciuto è una domanda nuova: senza il salto di versione, i libri futuri riuserebbero traduzioni fatte con un glossario diverso credendolo lo stesso.
4. Non si promuove ciò che non è approvato.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/terms-approve.test.ts`
Atteso: PASS, sei test.

- [ ] **Step 5: Commit**

```bash
git add app/main/terms app/test/terms-approve.test.ts app/shared/channels.ts app/main/ipc.ts
git commit -m "feat(terms): decide, edit and promote, and let a promotion bump the version"
```

---

### Task 2: Invalidazione selettiva

**Files:**
- Create: `app/main/terms/invalidate.ts`, `app/test/invalidate.test.ts`

**Interfaces:**

```ts
export interface InvalidationPreview {
  units: string[];              // gli id delle unità che perderebbero la traduzione
  cost: { tokensIn: number; tokensOut: number } | null;
}
export function previewInvalidation(db: DatabaseSync, projectId: string, changedTermIds: string[]): InvalidationPreview;
export function applyInvalidation(db: DatabaseSync, projectId: string, unitIds: string[], cacheKey: string): { removed: number };
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/invalidate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { applyInvalidation, previewInvalidation } from "../main/terms/invalidate.ts";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
    + "VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','running')").run();
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
  const texts = ["The road to Rivendell", "A quiet evening", "Rivendell again"];
  texts.forEach((text, i) => {
    db.prepare("INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, range_start, range_end, state, source_text) "
      + "VALUES (?,?,?,?,?,?,?,?,?)").run(`u${i + 1}`, "p1", "d1", i + 1, `c1.xhtml#${i + 1}`, i, i + 1, "translate", text);
    db.prepare("INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome) VALUES (?,?,?,?,?,?)")
      .run(`tr${i + 1}`, `u${i + 1}`, `traduzione ${i + 1}`, "k1", 1, "translated");
  });
  db.prepare("INSERT INTO term (id, project_id, source, target, rule, origin, approval_state) "
    + "VALUES ('t1','p1','Rivendell',NULL,'dnt','extracted','approved')").run();
  return db;
}

describe("invalidation", () => {
  it("names only the units that contain the changed term", () => {
    expect(previewInvalidation(seeded(), "p1", ["t1"]).units.sort()).toEqual(["c1.xhtml#1", "c1.xhtml#3"]);
  });

  it("says nothing is affected when the term appears nowhere", () => {
    const db = seeded();
    db.prepare("UPDATE term SET source='Mordor' WHERE id='t1'").run();
    expect(previewInvalidation(db, "p1", ["t1"]).units).toEqual([]);
  });

  it("removes only the named translations, and keeps the rest", () => {
    const db = seeded();
    expect(applyInvalidation(db, "p1", ["c1.xhtml#1", "c1.xhtml#3"], "k1")).toEqual({ removed: 2 });
    const left = db.prepare("SELECT count(*) AS n FROM translation WHERE cache_key='k1'").get() as { n: number };
    expect(left.n).toBe(1);
  });

  it("does not touch translations stored under another cache key", () => {
    const db = seeded();
    db.prepare("INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome) "
      + "VALUES ('other','u1','altra','k2',1,'translated')").run();
    applyInvalidation(db, "p1", ["c1.xhtml#1"], "k1");
    const kept = db.prepare("SELECT count(*) AS n FROM translation WHERE cache_key='k2'").get() as { n: number };
    expect(kept.n).toBe(1);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/invalidate.test.ts`
Atteso: FAIL, `Cannot find module '../main/terms/invalidate.ts'`.

- [ ] **Step 3: Implementare**

`previewInvalidation` riusa `unitsAffectedByTerms` del piano 2 sul testo sorgente delle unità, e stima quanto costerebbe rifarle.

**L'anteprima esiste perché la conferma sia informata**: l'interfaccia mostra "questa modifica ritraduce 34 unità" prima di applicare. Il prototipo, allo stesso evento, buttava via l'intera sessione e lo si scopriva dalla fattura.

`applyInvalidation` cancella solo le righe con quella coppia unità-chiave: la stessa unità sotto un'altra chiave appartiene a un'altra configurazione e non è affare di questa modifica.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/invalidate.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add app/main/terms/invalidate.ts app/test/invalidate.test.ts
git commit -m "feat(terms): preview what a change costs before it costs it"
```

---

### Task 3: Revisione delle esclusioni

**Files:**
- Create: `app/main/exclusions/review.ts`, `app/test/exclusions.test.ts`

**Interfaces:**

```ts
export interface ExclusionGroup {
  state: "code" | "translate-no" | "never-translated" | "uncomposable" | "maybe-code";
  reason: string | null;
  units: Array<{ unitId: string; text: string; forced: boolean }>;
}
export function listExclusions(db: DatabaseSync, projectId: string): ExclusionGroup[];
export function forceState(db: DatabaseSync, projectId: string, changes: Array<{
  unitId: string; state: "translate" | "code";
}>): { toTranslate: number; toCode: number };
export function clearForced(db: DatabaseSync, projectId: string, unitIds: string[]): { cleared: number };
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/exclusions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { clearForced, forceState, listExclusions } from "../main/exclusions/review.ts";

function seeded() {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
    + "VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','waiting-code')").run();
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
  const rows: Array<[string, string, string, string | null]> = [
    ["u1", "gem install foo", "code", "css-code-surface"],
    ["u2", "The src/ directory holds the sources", "code", "css-code-surface"],
    ["u3", "Acme Corp", "translate-no", null],
    ["u4", "A normal sentence", "translate", null],
  ];
  rows.forEach(([id, text, state, reason], i) => {
    db.prepare("INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, range_start, range_end, state, reason, source_text) "
      + "VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, "p1", "d1", i + 1, `c1.xhtml#${i + 1}`, i, i + 1, state, reason, text);
  });
  return db;
}

describe("exclusions", () => {
  it("groups what will not be translated by state and reason", () => {
    const groups = listExclusions(seeded(), "p1");
    expect(groups.map((g) => g.state).sort()).toEqual(["code", "translate-no"]);
    expect(groups.find((g) => g.state === "code")?.units).toHaveLength(2);
  });

  it("does not list units that are going to be translated", () => {
    expect(listExclusions(seeded(), "p1").flatMap((g) => g.units.map((u) => u.unitId))).not.toContain("c1.xhtml#4");
  });

  it("frees a block the user says is prose", () => {
    const db = seeded();
    expect(forceState(db, "p1", [{ unitId: "c1.xhtml#2", state: "translate" }])).toEqual({ toTranslate: 1, toCode: 0 });
    const row = db.prepare("SELECT forced_state, forced_by FROM unit WHERE id='u2'").get() as { forced_state: string; forced_by: string };
    expect(row).toMatchObject({ forced_state: "translate", forced_by: "user" });
  });

  it("protects a block the user says is code", () => {
    const db = seeded();
    expect(forceState(db, "p1", [{ unitId: "c1.xhtml#4", state: "code" }])).toEqual({ toTranslate: 0, toCode: 1 });
  });

  it("keeps the original state alongside the forced one, so a change can be undone", () => {
    const db = seeded();
    forceState(db, "p1", [{ unitId: "c1.xhtml#2", state: "translate" }]);
    expect(clearForced(db, "p1", ["c1.xhtml#2"])).toEqual({ cleared: 1 });
    const row = db.prepare("SELECT state, forced_state FROM unit WHERE id='u2'").get() as { state: string; forced_state: string | null };
    expect(row).toEqual({ state: "code", forced_state: null });
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/exclusions.test.ts`
Atteso: FAIL, `Cannot find module '../main/exclusions/review.ts'`.

- [ ] **Step 3: Implementare**

La forzatura scrive `forced_state` e `forced_by`, **senza toccare `state`**: lo stato dedotto resta, così la decisione dell'utente si può togliere e si può distinguere da ciò che il programma ha capito da solo. Il pianificatore del piano 2 legge `coalesce(forced_state, state)`.

Il raggruppamento è per stato e motivo, perché è così che si guarda: "quaranta blocchi esclusi dal foglio di stile" è una domanda sola, non quaranta.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/exclusions.test.ts`
Atteso: PASS, cinque test.

- [ ] **Step 5: Commit**

```bash
git add app/main/exclusions app/test/exclusions.test.ts
git commit -m "feat(exclusions): force a state without erasing what we deduced"
```

---

### Task 4: I glossari dell'applicazione

**Files:**
- Create: `app/main/glossaries/store.ts`, `app/test/glossaries.test.ts`

**Interfaces:**

```ts
export function listGlossaries(db: DatabaseSync): Glossary[];
export function saveGlossary(db: DatabaseSync, g: Glossary): Glossary;         // alza la versione se i termini cambiano
export function deleteGlossary(db: DatabaseSync, id: string): { detachedFrom: number };
export function importGlossary(db: DatabaseSync, markdown: string): Glossary;
export function exportGlossary(db: DatabaseSync, id: string): string;
export function attachToProject(db: DatabaseSync, projectId: string, glossaryId: string, chosenBy: "vote" | "user"): void;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/glossaries.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { attachToProject, deleteGlossary, exportGlossary, importGlossary, listGlossaries, saveGlossary } from "../main/glossaries/store.ts";
import { parseGlossary } from "../../core/glossary/index.ts";

const markdown = `---
name: fantasy
version: 2
description: Epic fantasy with invented names
sourceLanguage: en
targetLanguage: it
---

| source | target | rule | note |
|---|---|---|---|
| Rivendell |  | dnt | place name |
`;

function db() {
  const d = openDatabase(":memory:");
  migrate(d, loadMigrations("app/main/db/migrations"));
  return d;
}

describe("glossaries", () => {
  it("imports the format the prototype wrote, unchanged", () => {
    const d = db();
    const g = importGlossary(d, markdown);
    expect(g).toMatchObject({ name: "fantasy", version: 2 });
    expect(listGlossaries(d)).toHaveLength(1);
  });

  it("round-trips through export", () => {
    const d = db();
    importGlossary(d, markdown);
    const back = parseGlossary(exportGlossary(d, listGlossaries(d)[0].id));
    expect(back.terms).toEqual(parseGlossary(markdown).terms);
  });

  it("bumps the version when the terms change, and not when only the description does", () => {
    const d = db();
    const g = importGlossary(d, markdown);
    const described = saveGlossary(d, { ...g, description: "Better description" });
    expect(described.version).toBe(2);
    const grown = saveGlossary(d, {
      ...described, terms: [...described.terms, { source: "Mordor", rule: "dnt", origin: "glossary" }],
    });
    expect(grown.version).toBe(3);
  });

  it("detaches a deleted glossary from the projects that used it, and says how many", () => {
    const d = db();
    const g = importGlossary(d, markdown);
    d.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state) "
      + "VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','ready')").run();
    attachToProject(d, "p1", g.id, "user");
    expect(deleteGlossary(d, g.id)).toEqual({ detachedFrom: 1 });
  });

  it("refuses a glossary whose languages do not parse", () => {
    expect(() => importGlossary(db(), markdown.replace("sourceLanguage: en", "sourceLanguage:"))).toThrow();
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/glossaries.test.ts`
Atteso: FAIL, `Cannot find module '../main/glossaries/store.ts'`.

- [ ] **Step 3: Implementare**

Import ed export usano `parseGlossary` e `serializeGlossary` del piano 2: **è lo stesso formato del prototipo**, quindi i glossari già scritti si caricano senza riscriverli.

La versione sale **quando cambiano i termini**, non a ogni salvataggio: correggere un refuso nella descrizione non deve invalidare le traduzioni di tutti i libri che usano quel glossario. Cambiare i termini invece sì, ed è il motivo per cui la versione esiste.

Cancellare un glossario lo stacca dai progetti e lo dichiara: un progetto che perde in silenzio la sua terminologia è un libro che cambia tono a metà senza spiegazione.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/glossaries.test.ts`
Atteso: PASS, cinque test.

- [ ] **Step 5: Commit**

```bash
git add app/main/glossaries app/test/glossaries.test.ts
git commit -m "feat(glossaries): the prototype's format, and a version that moves for the right reason"
```

---

### Task 5: Il report

**Files:**
- Create: `app/main/report/build.ts`, `app/test/report.test.ts`

**Interfaces:**

```ts
export interface ReportLine { code: string; severity: "info" | "warning" | "degradation"; count: number; samples: unknown[] }
export interface Report {
  status: "complete" | "incomplete" | "failed";
  units: { total: number; translated: number; fellBack: number; identical: number; notTranslated: Record<string, number> };
  identicalWarning: boolean;                 // oltre il 5% di traduzioni uguali al sorgente
  degradations: ReportLine[];
  declarations: ReportLine[];                // ciò che è dichiarato e non è un difetto
  invariants: InvariantResult[];
  epubcheck: { ran: boolean; reason?: string; introduced: EpubcheckMessage[] };
  layout: { book: string; prePaginated: number };
  overlaysRemoved: { overlays: number; audio: number };
  terms: { active: number; adherence: { checked: number; respected: number } | null };
  cost: { tokensIn: number; tokensOut: number; amount: number | null };
  outputPath: string | null;
}
export function buildReport(db: DatabaseSync, projectId: string, runId: string): Report;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { buildReport } from "../main/report/build.ts";

function seeded(events: Array<[string, string]>, identical = 0, translated = 10) {
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare("INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at, target_language, state, layout) "
    + "VALUES ('p1','a.epub','A','/w','h','2026-08-24','it','done','reflowable')").run();
  db.prepare("INSERT INTO project_document (id, project_id, zip_path, spine_order) VALUES ('d1','p1','c1.xhtml',1)").run();
  db.prepare("INSERT INTO run (id, project_id, phase, started_at, tokens_in, tokens_out) "
    + "VALUES ('r1','p1','compose','2026-08-24',1000,500)").run();
  for (let i = 1; i <= translated; i++) {
    db.prepare("INSERT INTO unit (id, project_id, document_id, ordinal, unit_id, range_start, range_end, state, source_text) "
      + "VALUES (?,?,?,?,?,?,?,?,?)").run(`u${i}`, "p1", "d1", i, `c1.xhtml#${i}`, i, i + 1, "translate", `Text ${i}`);
    db.prepare("INSERT INTO translation (id, unit_id, text, cache_key, attempts, outcome) VALUES (?,?,?,?,?,?)")
      .run(`t${i}`, `u${i}`, i <= identical ? `Text ${i}` : `Testo ${i}`, "k1", 1, i <= identical ? "identical" : "translated");
  }
  events.forEach(([code, severity], i) => {
    db.prepare("INSERT INTO run_event (id, run_id, at, code, severity, payload_json) VALUES (?,?,?,?,?,?)")
      .run(`e${i}`, "r1", "2026-08-24", code, severity, "{}");
  });
  return db;
}

describe("buildReport", () => {
  it("groups events by code and counts them", () => {
    const report = buildReport(seeded([["unit-fell-back", "degradation"], ["unit-fell-back", "degradation"]]), "p1", "r1");
    expect(report.degradations).toEqual([
      expect.objectContaining({ code: "unit-fell-back", count: 2, severity: "degradation" }),
    ]);
  });

  it("keeps declarations apart from degradations", () => {
    const report = buildReport(seeded([["author-translate-no", "info"]]), "p1", "r1");
    expect(report.degradations).toEqual([]);
    expect(report.declarations.map((d) => d.code)).toEqual(["author-translate-no"]);
  });

  it("is incomplete when there is any degradation, complete when there is none", () => {
    expect(buildReport(seeded([["unit-fell-back", "degradation"]]), "p1", "r1").status).toBe("incomplete");
    expect(buildReport(seeded([]), "p1", "r1").status).toBe("complete");
  });

  it("warns when too many translations are identical to the source", () => {
    expect(buildReport(seeded([], 6, 10), "p1", "r1").identicalWarning).toBe(true);
    expect(buildReport(seeded([], 0, 10), "p1", "r1").identicalWarning).toBe(false);
  });

  it("carries codes, never sentences", () => {
    const report = buildReport(seeded([["unit-fell-back", "degradation"]]), "p1", "r1");
    expect(JSON.stringify(report)).not.toMatch(/fell back to the source/i);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/report.test.ts`
Atteso: FAIL, `Cannot find module '../main/report/build.ts'`.

- [ ] **Step 3: Implementare**

Il report è un'aggregazione di `run_event` più i conteggi delle unità e l'esito del gate. Due regole:

- **Degradazioni e dichiarazioni sono cose diverse.** Un'unità caduta sul sorgente è un difetto; una superficie che l'autore ha marcato `translate="no"` è comportamento corretto. Metterle nello stesso elenco insegna a ignorarlo.
- **Il report porta codici, non frasi.** Le frasi le compone l'interfaccia dal catalogo. È anche ciò che rende il report utile a un occhio esterno: due libri diversi producono gli stessi codici.

L'avviso sulle traduzioni identiche scatta oltre il 5%: è il sintomo di un modello che restituisce l'input, e senza l'avviso si scopre leggendo il libro.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/report.test.ts`
Atteso: PASS, cinque test.

- [ ] **Step 5: Commit**

```bash
git add app/main/report app/test/report.test.ts
git commit -m "feat(report): codes not sentences, and degradations apart from declarations"
```

---

### Task 6: Le schede del progetto

**Files:**
- Create: `app/renderer/src/app/project/project.component.ts`, `.../terms/terms.component.ts`, `.../exclusions/exclusions.component.ts`, `.../units/units.component.ts`, `.../report/report.component.ts` (con template e stili), più i loro `.spec.ts`
- Modify: `app/shared/channels.ts`, `app/main/ipc.ts`, `app/locales/it.json`, `app/locales/en.json`

**Interfaces:**
- Consumes: i Task 1-5 di questo piano, gli eventi `run.phase`, `run.progress`, `project.changed` del piano 4
- Produces: le cinque schede della spec, e i due gate che sbloccano la macchina.

- [ ] **Step 1: Scrivere i test che falliscono**

`app/renderer/src/app/project/terms/terms.component.spec.ts`:

```ts
import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import { TermsComponent } from "./terms.component.ts";
import { IpcService } from "../../core/ipc.service.ts";

const terms = [
  { id: "t1", source: "Rivendell", target: null, rule: "dnt", origin: "extracted", approval: "pending", occurrences: 4, context: "The road to Rivendell", note: null },
  { id: "t2", source: "dwarf", target: "nano", rule: "must", origin: "extracted", approval: "pending", occurrences: 9, context: "the dwarf spoke", note: null },
];

function mount(invoke = vi.fn().mockResolvedValue(terms)) {
  TestBed.configureTestingModule({
    imports: [TermsComponent],
    providers: [{ provide: IpcService, useValue: { invoke, on: () => () => {} } }],
  });
  const fixture = TestBed.createComponent(TermsComponent);
  fixture.componentRef.setInput("projectId", "p1");
  fixture.detectChanges();
  return { fixture, invoke };
}

describe("TermsComponent", () => {
  it("shows each candidate with the sentence it came from", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("Rivendell");
    expect(text).toContain("The road to Rivendell");
  });

  it("sends every decision in one call, not one call per term", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();
    fixture.componentInstance.approveAll();
    await fixture.whenStable();
    const calls = invoke.mock.calls.filter(([channel]) => channel === "terms.decide");
    expect(calls).toHaveLength(1);
    expect(calls[0][1].decisions).toHaveLength(2);
  });

  it("asks for confirmation before a change that invalidates translations", async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce(terms)
      .mockResolvedValueOnce({ units: ["c1.xhtml#1", "c1.xhtml#3"], cost: { tokensIn: 100, tokensOut: 50 } });
    const { fixture } = mount(invoke);
    await fixture.whenStable();
    fixture.componentInstance.edit("t1", { target: "Forravalle" });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("2");
    expect(invoke.mock.calls.some(([c]) => c === "terms.decide")).toBe(false);
  });

  it("renders no hand-written sentence: every label is a catalogue key", () => {
    const template = TermsComponent.prototype.constructor.toString();
    expect(template).not.toMatch(/Approva|Approve all|Rifiuta/);
  });
});
```

Gli altri quattro componenti hanno uno `spec.ts` con la stessa forma: *Exclusions* verifica che i gruppi si vedano e che forzare uno stato mandi una sola chiamata; *Units* verifica il filtro per stato e la ricerca; *Report* verifica che un codice diventi una chiave di catalogo e che "EPUBCheck non eseguito" non appaia come un successo; *Project* verifica che i pulsanti disponibili vengano dalla macchina (`can`) e non da un `if` sullo stato.

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/renderer/src/app/project`
Atteso: FAIL, i componenti non esistono.

- [ ] **Step 3: Implementare**

Le cinque schede:

- **Panoramica** — le fasi con il loro esito, avanzamento a unità, token e costo, eventi recenti.
- **Termini** — il gate: candidati con la frase da cui vengono, accetta, rifiuta, modifica, accettazione in blocco, promozione al glossario. Approvare manda `TERMS_APPROVED` e il run riparte.
- **Esclusioni** — il gate: gruppi per motivo, testo del blocco, forzatura nei due sensi. Confermare manda `CODE_REVIEWED`.
- **Unità** — sorgente e traduzione affiancate, filtro per stato, ricerca. È la scheda con cui si controlla davvero un libro, e nel prototipo mancava del tutto.
- **Report** — degradazioni, dichiarazioni, invarianti, EPUBCheck, e i pulsanti per aprire l'EPUB e la cartella.

Tre regole per tutte:

1. **I pulsanti chiedono alla macchina.** `snapshot.can({ type: "RESUME" })` decide se sono abilitati: una condizione riscritta a mano nel template diverge dalla macchina il giorno in cui la macchina cambia.
2. **Le decisioni si mandano in blocco.** Approvare quaranta termini è una chiamata, non quaranta: quaranta transazioni separate lasciano lo stato a metà se qualcosa fallisce nel mezzo.
3. **Ogni modifica che invalida traduzioni passa dall'anteprima** del Task 2, e la conferma dice quante unità e quanto costa.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/renderer/src/app/project`
Atteso: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/project app/shared/channels.ts app/main/ipc.ts app/locales
git commit -m "feat(renderer): five tabs, two gates, and buttons that ask the machine"
```

---

### Task 7: Impostazioni e localizzazione completa

**Files:**
- Create: `app/renderer/src/app/settings/settings.component.ts`, `.../settings/glossaries.component.ts`, `.../settings/providers.component.ts` (con template), `app/test/locales.test.ts`
- Modify: `app/locales/it.json`, `app/locales/en.json`

**Interfaces:**

```ts
export interface Settings {
  uiLanguage: string;
  autoAcceptTerms: boolean;
  autoAcceptExclusions: boolean;
  concurrency: number;
  epubcheckJar: string | null;
}
```

- [ ] **Step 1: Scrivere i test che falliscono**

`app/test/locales.test.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const load = async (lang: string) => JSON.parse(await readFile(`app/locales/${lang}.json`, "utf8"));

function keys(object: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(object).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]);
}

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(p)));
    else if (/\.(ts|html)$/.test(e.name) && !e.name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

describe("catalogues", () => {
  it("has the same keys in every language", async () => {
    const it = keys(await load("it")).sort();
    const en = keys(await load("en")).sort();
    expect(it).toEqual(en);
  });

  it("has a key for every code the core can emit", async () => {
    const it = keys(await load("it"));
    for (const code of ["unsupported-encoding", "unit-fell-back", "chunk-exhausted", "abstained", "unreliable-range"]) {
      expect(it).toContain(`codes.${code}`);
    }
  });

  it("has a key for every invariant", async () => {
    const it = keys(await load("it"));
    for (let i = 1; i <= 22; i++) expect(it).toContain(`invariants.I${i}`);
  });

  it("uses no key the catalogues do not define", async () => {
    const defined = new Set(keys(await load("it")));
    const used = new Set<string>();
    for (const file of await sources("app/renderer/src")) {
      const text = await readFile(file, "utf8");
      for (const m of text.matchAll(/transloco:\s*'([^']+)'|t\(\s*'([^']+)'/g)) used.add(m[1] ?? m[2]);
    }
    expect([...used].filter((k) => !defined.has(k))).toEqual([]);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run app/test/locales.test.ts`
Atteso: FAIL, mancano chiavi.

- [ ] **Step 3: Implementare**

La schermata delle impostazioni ha quattro sezioni: **provider** (elenco, preset, chiave, modelli con prezzi, pulsante Verifica del piano 4), **glossari** (elenco, editor dei termini, import ed export), **traduzione** (auto-accettazione dei due gate, indipendenti; concorrenza dei gruppi), **applicazione** (lingua dell'interfaccia, percorso del jar di EPUBCheck).

I quattro test del catalogo sono la rete che tiene la localizzazione: **una chiave usata e non definita si vede subito**, e una lingua che resta indietro sull'altra pure. Senza, la traduzione dell'interfaccia marcisce in silenzio a ogni funzione nuova.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run app/test/locales.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/settings app/locales app/test/locales.test.ts
git commit -m "feat(settings): four sections, and a net under the catalogues"
```

---

### Task 8: I gate, dall'inizio alla fine

**Files:**
- Create: `app/e2e/gates.spec.ts`

**Interfaces:**
- Produces: la prova che i due gate fermano e sbloccano davvero il run.

- [ ] **Step 1: Scrivere il test che fallisce**

`app/e2e/gates.spec.ts` avvia l'applicazione con il backend finto del piano 4 e **l'auto-accettazione spenta**, crea un progetto, avvia la traduzione, e poi:

1. aspetta che lo stato diventi `waiting-terms` e che la scheda Termini mostri i candidati;
2. modifica la resa di un termine, verifica che compaia la conferma con il numero di unità coinvolte, conferma;
3. approva tutto e verifica che il run riparta;
4. aspetta `waiting-code`, libera un blocco marcato dal foglio di stile, conferma;
5. aspetta `done` e apre la scheda Report, verificando che mostri l'esito delle invarianti e che EPUBCheck risulti "non eseguito" e non "passato";
6. verifica che il file esista nella cartella di output.

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

Run: `npm run test:e2e -w app`
Atteso: FAIL.

- [ ] **Step 3: Completare i `data-testid` e i collegamenti mancanti**

Aggiungere gli attributi che il test nomina, e collegare i pulsanti dei due gate agli eventi `TERMS_APPROVED` e `CODE_REVIEWED` del piano 4.

- [ ] **Step 4: Eseguire la prova**

Run: `npm run test:e2e -w app`
Atteso: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/e2e/gates.spec.ts app/renderer/src
git commit -m "test(app): stop at both gates, and start again from the interface"
```

---

## Definizione di finito

- Tutta la suite verde, prove end-to-end comprese.
- I due gate fermano il run e lo sbloccano dall'interfaccia; l'auto-accettazione li salta, uno per uno.
- Modificare un termine dopo la partenza dichiara quante unità verranno ritradotte, e ne ritraduce solo quelle.
- La scheda Unità mostra sorgente e traduzione affiancate, con filtro e ricerca.
- Il report distingue degradazioni e dichiarazioni, e non chiama mai "passato" un EPUBCheck che non è stato eseguito.
- I cataloghi hanno le stesse chiavi in tutte le lingue, una chiave per ogni codice del core e per ognuna delle ventidue invarianti, e nessun componente usa una chiave che non esiste.

## Cosa resta fuori da tutti e cinque i piani

- **Font offuscati**: mai passati dalla pipeline. Il fallimento è invisibile ai controlli, perché EPUBCheck emette `RSC-004` e salta il contenuto delle risorse cifrate. Serve un libro reale con font offuscati, tradotto e aperto in un lettore.
- **Impaginazione fissa**: rilevata e dichiarata, mai risolta. L'avviso dice che il testo non si riadatta; nessuno verifica che non trabocchi.
- **Rimozione degli overlay su un audiolibro vero**: specificata, coperta da un'invariante e provata sulle fixture, mai eseguita su un libro con audio reale.
- **Impacchettamento e distribuzione**: `electron-builder`, firma, aggiornamenti. Nessun piano lo tocca.
