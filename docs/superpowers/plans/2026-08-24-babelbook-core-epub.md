# babelBook — Piano 1: il layer EPUB del core

**Stato: completo** — 17 task su 17, al 2026-08-25. Il codice vive in `core/epub/`.
Quello che l'esecuzione ha smentito è in fondo, nella sezione *Esito dell'esecuzione*:
leggila prima di fidarti di un dettaglio scritto qui sopra.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** costruire `core/epub/`, il layer che legge un EPUB, lo scompone in unità di traduzione e lo ricompone, con un corpus di test e le invarianti che dimostrano che la ricomposizione non perde niente.

**Architecture:** nessun LLM, nessun database, nessuna interfaccia. Il layer prende byte e restituisce byte. L'unità di traduzione è il **blocco foglia** con il markup inline mascherato in segnaposto numerati; la reinserzione passa da uno **scheletro** in cui ogni unità radice è sostituita da un delimitatore, e riempirlo con traduzioni vuote deve restituire l'archivio identico byte per byte. Chi verifica non condivide il parser con chi trasforma.

**Tech Stack:** TypeScript su Node 24.18.x, ESM, vitest, `saxes` (tokenizer XML), `yauzl-promise` (lettura zip), `yazl` (scrittura zip).

**Spec:** `docs/superpowers/specs/2026-08-24-babelbook-design.md`

## Scomposizione in piani

Questo è il primo di cinque. Ognuno produce software che funziona da solo.

| Piano | Contenuto | Dipende da |
|---|---|---|
| **1. Layer EPUB del core** (questo) | zip, scan, blocchi, scheletro, package, overlay, layout, invarianti, corpus | — |
| 2. Layer traduzione del core | porte, pianificazione, protocollo, validazione, motore, glossari, analisi | 1 |
| 3. Shell Electron e database | main, preload, migrazioni, `ProjectStore` su `node:sqlite`, creazione progetto, libreria Angular | 1 |
| 4. Esecuzione, provider e composizione | provider e chiavi cifrate, `utilityProcess`, macchina a stati XState, pausa e ripresa, tray, composizione dell'EPUB | 2, 3 |
| 5. Gate, glossari e report | approvazione termini, revisione esclusioni, scheda unità, report, glossari, impostazioni, i18n | 4 |

## Global Constraints

Valgono per ogni task di questo piano.

- **Node 24.18.x**, non in `PATH` nelle shell non interattive. Esportarlo prima di ogni comando:
  `export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`
- **ESM ovunque**: `"type": "module"` in ogni `package.json`.
- **Gli import portano l'estensione `.ts`**, non `.js`. `import "./types.js"` fallisce: Node non rimappa l'estensione quando esegue TypeScript per type stripping.
- **Solo sintassi cancellabile**: niente `enum`, niente `namespace`, niente parameter properties (`constructor(readonly x: string)` fallisce con `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). I campi si dichiarano e si assegnano a mano.
- **`core/` non importa Electron, `node:sqlite`, o alcun pacchetto di provider LLM.** Un test lo fa rispettare (Task 1).
- **Codice, commenti, nomi di test e messaggi di errore in inglese.** I documenti di progetto sono in italiano.
- **Il core non produce testo rivolto all'utente.** Gli errori portano un `code` stabile (`UNSUPPORTED_ENCODING`, `ENTRY_TOO_LARGE`, …); la frase la compone l'interfaccia.
- **Test:** `npm test -w core` esegue `vitest run`. Un singolo file: `npx vitest run core/test/<file>.test.ts`.
- **Dipendenze ammesse in `core/`:** `saxes`, `yauzl-promise`, `yazl`. Nient'altro senza una decisione esplicita.
- **Commit a ogni task**, con messaggio in inglese in stile conventional commit.

## Struttura dei file

```
package.json                 root del workspace npm (private, workspaces: ["core"])
core/
  package.json               name: @babelbook/core, type: module, test: vitest run
  tsconfig.json              erasableSyntaxOnly, allowImportingTsExtensions, noEmit
  types/yauzl-promise.d.ts   dichiarazione a mano: il pacchetto non ha tipi
  epub/
    errors.ts                EpubError e le sue specializzazioni, con `code`
    zip.ts                   readEpub, writeEpub, sha256, LIMITS
    entities.ts              tabella delle entità XHTML 1.0
    scan.ts                  eventi con offset, decodeEntities, escapeText, escapeAttr
    blocks.ts                extract: unità, stati, segnaposto, attributi
    css.ts                   superfici di codice dedotte dai fogli di stile
    skeleton.ts              buildSkeleton, fillSkeleton
    splice.ts                render di una singola unità
    package.ts               readPackage, writeLanguage
    overlay.ts               rimozione dei media overlay
    layout.ts                rilevamento di rendition:layout
    inspect.ts               modello del libro, con walker XML indipendente
    invariants.ts            I1..I22
    epubcheck.ts             esecuzione opzionale del jar
    index.ts                 superficie pubblica
  test/
    corpus/build.ts          generatore di fixture EPUB (usa yazl direttamente)
    corpus/sabotage.ts       sabotaggi mappati alle invarianti che devono scattare
    *.test.ts                un file per modulo
```

---

### Task 1: Bootstrap del workspace e confine del core

**Files:**
- Create: `package.json`, `core/package.json`, `core/tsconfig.json`, `core/test/boundary.test.ts`, `.gitignore`
- Modify: nessuno

**Interfaces:**
- Consumes: niente
- Produces: il comando `npm test -w core`, e il test di confine che ogni task successivo eredita.

- [ ] **Step 1: Scrivere il test che fallisce**

`core/test/boundary.test.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = [/from\s+["']electron["']/, /from\s+["']node:sqlite["']/, /@ai-sdk\//];

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("core boundary", () => {
  it("imports neither Electron, nor node:sqlite, nor a provider package", async () => {
    const offenders: string[] = [];
    for (const file of await sources("core")) {
      const text = await readFile(file, "utf8");
      for (const rule of FORBIDDEN) if (rule.test(text)) offenders.push(`${file}: ${rule}`);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
npm test -w core
```

Atteso: fallisce perché il workspace non esiste ancora (`npm error Workspace not found`).

- [ ] **Step 3: Creare il workspace**

`package.json` (root):

```json
{
  "name": "babelbook",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["core"],
  "engines": { "node": ">=24" },
  "scripts": { "test": "npm test -w core", "typecheck": "npm run typecheck -w core" }
}
```

`core/package.json`:

```json
{
  "name": "@babelbook/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "test:watch": "vitest", "typecheck": "tsc --noEmit" },
  "dependencies": { "saxes": "^6.0.0", "yauzl-promise": "^4.0.0", "yazl": "^3.3.1" },
  "devDependencies": { "@types/node": "^26.2.0", "@types/yazl": "^3.3.1", "typescript": "^5.8.0", "vitest": "^4.1.10" }
}
```

`core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["epub", "test", "types"]
}
```

`.gitignore`: aggiungere `node_modules/`, `dist/`, `.idea/`, `vendor/`.

- [ ] **Step 4: Installare ed eseguire**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
npm install
npm test -w core
```

Atteso: PASS, un test.

- [ ] **Step 5: Commit**

```bash
git add package.json core .gitignore package-lock.json
git commit -m "chore: npm workspace with a core package that cannot import the host"
```

---

### Task 2: Generatore di fixture EPUB

**Files:**
- Create: `core/test/corpus/build.ts`, `core/test/corpus/build.test.ts`, `core/types/yauzl-promise.d.ts`

**Interfaces:**
- Consumes: niente
- Produces:
  - `buildEpub(spec: EpubSpec): Promise<Buffer>`
  - `interface EpubSpec { identifier?: string; language?: string; title?: string; documents: Array<{ path: string; xhtml: string; layout?: "reflowable" | "pre-paginated" }>; extra?: Array<{ path: string; bytes: Buffer }>; packageProperties?: string; manifestExtra?: string; metadataExtra?: string; }`

**Perché è un modulo a sé:** il generatore scrive lo zip con `yazl` **direttamente**, senza passare da `core/epub/zip.ts`. È deliberato: se le fixture fossero prodotte dallo stesso scrittore che i test verificano, un difetto dello scrittore sarebbe simmetrico e quindi invisibile.

- [ ] **Step 1: Scrivere il test che fallisce**

`core/test/corpus/build.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { open } from "yauzl-promise";
import { buildEpub } from "./build.ts";

describe("buildEpub", () => {
  it("writes mimetype first, stored, with the exact media type", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hello</p>" }],
    });
    expect(bytes.subarray(30, 38).toString("ascii")).toBe("mimetype");
    expect(bytes.subarray(38, 58).toString("ascii")).toBe("application/epub+zip");
  });

  it("declares every document in manifest and spine", async () => {
    const bytes = await buildEpub({
      documents: [
        { path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" },
        { path: "OEBPS/c2.xhtml", xhtml: "<p>Two</p>" },
      ],
    });
    const zip = await open(bytes);
    const names: string[] = [];
    for await (const e of zip) names.push(e.filename);
    await zip.close();
    expect(names).toContain("OEBPS/content.opf");
    expect(names).toContain("OEBPS/c2.xhtml");
  });
});
```

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

Run: `npx vitest run core/test/corpus/build.test.ts`
Atteso: FAIL, `Cannot find module './build.ts'`.

- [ ] **Step 3: Scrivere il generatore**

`core/test/corpus/build.ts` deve:

1. accettare lo `EpubSpec` descritto sopra, con default: `identifier` `"urn:uuid:11111111-2222-3333-4444-555555555555"`, `language` `"en"`, `title` `"Fixture"`;
2. avvolgere ogni `xhtml` in un documento completo, con `<?xml version="1.0" encoding="utf-8"?>` e `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{language}">`, `<head><title>…</title></head>`, e il meta `viewport` `width=1200, height=1600` se `layout` è `pre-paginated`;
3. generare `META-INF/container.xml` che punta a `OEBPS/content.opf`;
4. generare l'OPF con `dc:identifier` (id `pub-id`, referenziato da `unique-identifier`), `dc:title`, `dc:language`, `dcterms:modified`, il manifest con un `<item>` per documento più il nav, la spine nell'ordine dato, e le stringhe grezze `packageProperties`, `manifestExtra`, `metadataExtra` interpolate dove indicano i loro nomi;
5. generare `OEBPS/nav.xhtml` con `<nav epub:type="toc">` e un `<li><a href="…">` per documento;
6. scrivere lo zip con `yazl`: **`mimetype` come prima entry, con `compress: false`**, tutto il resto deflated;
7. restituire il `Buffer` completo.

`core/types/yauzl-promise.d.ts` dichiara solo la superficie usata: `open(path | Buffer): Promise<ZipFile>`, `ZipFile` iterabile in modo asincrono con `close()`, `Entry` con `filename`, `uncompressedSize`, `compressedSize`, `openReadStream()`, e la funzione `validateFilename` — **si chiama così, non `validateFileName` come dice il README del pacchetto**.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/corpus/build.test.ts`
Atteso: PASS, due test.

- [ ] **Step 5: Commit**

```bash
git add core/test/corpus core/types
git commit -m "test: an EPUB fixture builder that does not share a writer with the code under test"
```

---

### Task 3: Lettura e scrittura dell'archivio

**Files:**
- Create: `core/epub/errors.ts`, `core/epub/zip.ts`, `core/test/zip.test.ts`

**Interfaces:**
- Consumes: `buildEpub` (Task 2)
- Produces:
  - `class EpubError extends Error { code: string }`, e le sottoclassi `EpubReadError`, `EpubWriteError`, `ScanError`, tutte con `code`
  - `const LIMITS = { maxEntries: 5_000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxCompressionRatio: 200 }`
  - `sha256(buf: Buffer): string`
  - `interface ZipEntry { path: string; bytes: Buffer; compress: boolean }`
  - `readEpub(input: string | Buffer): Promise<EpubArchive>` con `EpubArchive { entries: ZipEntry[]; order: string[]; get(path: string): Buffer | undefined; sha256: string }`
  - `writeEpub(entries: ZipEntry[], opts?: { conformant?: boolean }): Promise<Buffer>`

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/zip.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { LIMITS, readEpub, writeEpub } from "../epub/zip.ts";
import { EpubReadError } from "../epub/errors.ts";

describe("readEpub", () => {
  it("reads every entry and keeps the archive order", async () => {
    const bytes = await buildEpub({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    const epub = await readEpub(bytes);
    expect(epub.order[0]).toBe("mimetype");
    expect(epub.get("OEBPS/c1.xhtml")?.toString("utf8")).toContain("<p>Hi</p>");
  });

  it("refuses an entry whose name escapes the archive", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }],
      extra: [{ path: "../escape.txt", bytes: Buffer.from("nope") }],
    });
    await expect(readEpub(bytes)).rejects.toMatchObject({ code: "UNSAFE_ENTRY_NAME" });
  });

  it("refuses an archive with too many entries", async () => {
    const documents = Array.from({ length: LIMITS.maxEntries + 1 }, (_, i) => ({
      path: `OEBPS/c${i}.xhtml`,
      xhtml: "<p>x</p>",
    }));
    const bytes = await buildEpub({ documents });
    await expect(readEpub(bytes)).rejects.toBeInstanceOf(EpubReadError);
  });
});

describe("writeEpub", () => {
  it("round-trips an archive byte for byte through read and write", async () => {
    const bytes = await buildEpub({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    const first = await readEpub(bytes);
    const written = await writeEpub(first.entries);
    const second = await readEpub(written);
    expect(second.order).toEqual(first.order);
    for (const path of first.order) {
      expect(second.get(path)).toEqual(first.get(path));
    }
  });

  it("writes mimetype first and stored", async () => {
    const written = await writeEpub([
      { path: "OEBPS/c1.xhtml", bytes: Buffer.from("<p/>"), compress: true },
      { path: "mimetype", bytes: Buffer.from("application/epub+zip"), compress: false },
    ]);
    expect(written.subarray(30, 38).toString("ascii")).toBe("mimetype");
  });

  it("can write a non-conformant archive on purpose", async () => {
    const written = await writeEpub(
      [{ path: "OEBPS/c1.xhtml", bytes: Buffer.from("<p/>"), compress: true }],
      { conformant: false },
    );
    expect(written.subarray(30, 38).toString("ascii")).not.toBe("mimetype");
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/zip.test.ts`
Atteso: FAIL, `Cannot find module '../epub/zip.ts'`.

- [ ] **Step 3: Implementare errori e archivio**

`core/epub/errors.ts` — nessuna parameter property, i campi si assegnano a mano:

```ts
export class EpubError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class EpubReadError extends EpubError {}
export class EpubWriteError extends EpubError {}
export class ScanError extends EpubError {}
```

`core/epub/zip.ts`:

- `readEpub` apre con `yauzl-promise`, itera le entry **nell'ordine dell'archivio**, e per ognuna: valida il nome con `validateFilename` e rifiuta con `code: "UNSAFE_ENTRY_NAME"` se il nome è assoluto o contiene `..`; applica i quattro `LIMITS` (`TOO_MANY_ENTRIES`, `ENTRY_TOO_LARGE`, `ARCHIVE_TOO_LARGE`, `SUSPICIOUS_COMPRESSION_RATIO`, quest'ultimo solo se `compressedSize > 0`); legge lo stream in un `Buffer`. `compress` è `false` per `mimetype`, `true` altrimenti. `sha256` è calcolato sull'input completo.
- `writeEpub` usa `yazl`. Con `conformant` non falso, sposta `mimetype` in testa e lo scrive con `{ compress: false }`; se manca, lo aggiunge. Con `conformant: false` scrive le entry nell'ordine ricevuto senza correggere niente — **è l'unico modo di produrre un archivio che violi le invarianti di packaging, e serve ai sabotaggi del Task 15**: uno scrittore che corregge sempre rende irraggiungibile l'invariante che dovrebbe rilevare il difetto.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/zip.test.ts`
Atteso: PASS, sei test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/errors.ts core/epub/zip.ts core/test/zip.test.ts
git commit -m "feat(epub): read and write the archive, with a deliberate escape hatch for sabotage"
```

---

### Task 4: Scansione XML con offset

**Files:**
- Create: `core/epub/entities.ts`, `core/epub/scan.ts`, `core/test/scan.test.ts`

**Interfaces:**
- Consumes: `ScanError` (Task 3)
- Produces:
  - `const XHTML_ENTITIES: Record<string, string>`
  - `type ScanKind = "opentag" | "closetag" | "text" | "cdata" | "comment" | "pi" | "doctype"`
  - `interface ScanAttr { name: string; value: string; start: number; end: number }` — offset del **valore**, virgolette escluse, relativi al tag di apertura
  - `interface ScanEvent { kind: ScanKind; name?: string; attrs?: ScanAttr[]; text?: string; rawStart: number; rawEnd: number; reliable: boolean }`
  - `scan(source: string, path: string): ScanEvent[]`
  - `assertUtf8(bytes: Buffer, path: string): string` — decodifica o lancia `code: "UNSUPPORTED_ENCODING"`
  - `assertWellFormed(source: string, path: string): void`
  - `decodeEntities(raw: string): string`, `escapeText(s: string): string`, `escapeAttr(s: string): string`

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/scan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeEntities, escapeAttr, escapeText, scan } from "../epub/scan.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>`
  + `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

describe("scan", () => {
  it("reports a text range that slices back to the same bytes", () => {
    const source = doc("<p>Hello</p>");
    const text = scan(source, "c1.xhtml").find((e) => e.kind === "text" && e.text === "Hello");
    expect(text).toBeDefined();
    expect(source.slice(text!.rawStart, text!.rawEnd)).toBe("Hello");
  });

  it("keeps an entity inside a single text event and decodes it", () => {
    const source = doc("<p>a &amp; b</p>");
    const text = scan(source, "c1.xhtml").find((e) => e.kind === "text" && e.text?.includes("&"));
    expect(text!.text).toBe("a & b");
    expect(source.slice(text!.rawStart, text!.rawEnd)).toBe("a &amp; b");
  });

  it("parses an XHTML 1.0 named entity that plain XML does not know", () => {
    const source = doc("<p>&copy; 2026 &hellip;</p>");
    const events = scan(source, "c1.xhtml");
    const text = events.find((e) => e.kind === "text");
    expect(text!.text).toBe("© 2026 …");
    expect(text!.reliable).toBe(true);
  });

  it("reports attribute value offsets relative to the opening tag", () => {
    const source = doc(`<img src="x.png" alt="A cat"/>`);
    const open = scan(source, "c1.xhtml").find((e) => e.kind === "opentag" && e.name === "img");
    const alt = open!.attrs!.find((a) => a.name === "alt")!;
    const tag = source.slice(open!.rawStart, open!.rawEnd);
    expect(tag.slice(alt.start, alt.end)).toBe("A cat");
  });
});

describe("escaping", () => {
  it("round-trips through decode after escape", () => {
    expect(decodeEntities(escapeText("a & b < c"))).toBe("a & b < c");
    expect(escapeAttr('say "hi"')).toContain("&quot;");
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/scan.test.ts`
Atteso: FAIL, `Cannot find module '../epub/scan.ts'`.

- [ ] **Step 3: Implementare entità e scansione**

`core/epub/entities.ts` esporta `XHTML_ENTITIES`, la tabella delle entità nominate di XHTML 1.0. Costruirla da due sorgenti compatte: il blocco Latin-1, che è contiguo da U+00A0 e quindi si genera dalla posizione nell'elenco (`nbsp iexcl cent pound … yuml`), e un elenco `nome:codepoint` per i blocchi non contigui (Latin Extended, punteggiatura, greco, matematica: `OElig:338`, `ndash:8211`, `hellip:8230`, `euro:8364`, `trade:8482`, …).

**Una tabella sola, due consumatori.** `scan.ts` la passa al parser *e* la usa per decodificare gli intervalli grezzi. Se i due divergessero, un intervallo che contiene un'entità decodificherebbe diversamente da quanto riportato dal parser, verrebbe marcato inaffidabile, e la frase sparirebbe dalla traduzione in silenzio — un fallimento peggiore di quello che la tabella risolve.

`core/epub/scan.ts`:

```ts
import { SaxesParser } from "saxes";
import { XHTML_ENTITIES } from "./entities.ts";
import { ScanError } from "./errors.ts";
```

- `scan` crea `new SaxesParser({ xmlns: true, position: true, fileName: path })` e fa `Object.assign(parser.ENTITIES, XHTML_ENTITIES)` **prima** di scrivere il sorgente. Tutto il documento va scritto in una sola `write()`: è ciò che fa coalescere le entità in un unico evento `text`, e l'allineamento intervallo↔evento dipende da questo.
- **Semantica delle posizioni di saxes**: l'evento `text` scatta *dopo* che il parser ha consumato il `<` che chiude il nodo, quindi `rawEnd = parser.position - 1`. `rawStart` è la posizione successiva all'ultimo evento **strutturale** (`opentag`, `closetag`, `cdata`, …), **non** `opentagstart`, che riporta a metà tag. Sbagliare questo è il difetto più facile da introdurre e il più difficile da vedere: gli offset restano plausibili e il testo scivola di pochi caratteri.
- `reliable` è `false` quando `decodeEntities(source.slice(rawStart, rawEnd))`, normalizzato nei fine riga, non coincide con il testo riportato dal parser. Un'unità costruita su un evento inaffidabile riceverà lo stato `uncomposable` nel Task 5.
- Gli offset degli attributi si ricavano cercando il valore dentro il tag grezzo e confermando che `decodeEntities` della porzione trovata coincide col valore riportato: senza la conferma, un attributo che ripete il testo di un altro dà un offset sbagliato.
- `assertUtf8` decodifica con `new TextDecoder("utf-8", { fatal: true })` e converte l'eccezione in `ScanError` con `code: "UNSUPPORTED_ENCODING"`. Non si indovina mai la codifica: fallire ad alta voce è il punto.
- `assertWellFormed` esegue una scansione e converte qualunque errore del parser in `ScanError` con `code: "MALFORMED_XML"`.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/scan.test.ts`
Atteso: PASS, cinque test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/entities.ts core/epub/scan.ts core/test/scan.test.ts
git commit -m "feat(epub): locate text ranges with saxes, and teach it the XHTML entities"
```

---

### Task 5: Unità di blocco e stati deterministici

**Files:**
- Create: `core/epub/blocks.ts`, `core/test/blocks.test.ts`

**Interfaces:**
- Consumes: `scan`, `decodeEntities` (Task 4)
- Produces:

```ts
export type UnitKind = "block" | "text" | "attribute";

export type UnitState =
  | "translate"        // da tradurre
  | "maybe-code"       // tradotto, ma l'indice del codice sospetta sia codice
  | "code"             // codice: non si traduce
  | "never-translated" // script, style: non è testo del libro
  | "translate-no"     // l'autore ha scritto translate="no"
  | "uncomposable";    // l'intervallo non è affidabile: non si tocca

export interface TranslationUnit {
  id: string;               // `${doc}#${ordinal}`
  kind: UnitKind;
  doc: string;
  ordinal: number;
  range: [number, number];  // intervallo nel sorgente
  source: string;           // testo decodificato, markup inline mascherato
  raw: string;              // i byte dell'intervallo, non il testo decodificato
  state: UnitState;
  reason?: string;          // codice, non frase: "css-code-surface", "unreliable-range"
  placeholders?: Placeholder[];
  owner?: string;           // solo per le unità attributo: l'unità blocco che le contiene
}

export interface ExtractReport {
  units: TranslationUnit[];
  skipped: Array<{ doc: string; reason: string; degraded: boolean }>;
}

export const BLOCKS: Set<string>;
export const NAV_BLOCKS: Set<string>;
export const NEVER_TRANSLATED: Set<string>;
export const OPAQUE: Set<string>;
export function isWork(state: UnitState): boolean;   // true per "translate" e "maybe-code"
export function extract(input: {
  source: string;
  doc: string;
  nav?: boolean;
  codeSurfaces?: Set<string>;   // classi risolte dal foglio di stile, dal Task 7
}): ExtractReport;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/blocks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extract } from "../epub/blocks.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>`
  + `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

describe("extract", () => {
  it("takes the innermost block as the unit, not its container", () => {
    const { units } = extract({ source: doc("<div><p>One</p><p>Two</p></div>"), doc: "c1.xhtml" });
    expect(units.map((u) => u.source)).toEqual(["One", "Two"]);
    expect(units.map((u) => u.id)).toEqual(["c1.xhtml#1", "c1.xhtml#2"]);
  });

  it("registers code blocks instead of dropping them, so ordinals do not shift", () => {
    const { units } = extract({ source: doc("<p>One</p><pre>x = 1</pre><p>Two</p>"), doc: "c1.xhtml" });
    expect(units.map((u) => u.state)).toEqual(["translate", "code", "translate"]);
    expect(units[2].id).toBe("c1.xhtml#3");
  });

  it("honours translate=no on the block and on an ancestor", () => {
    const { units } = extract({
      source: doc(`<p translate="no">Brand</p><div translate="no"><p>Also brand</p></div>`),
      doc: "c1.xhtml",
    });
    expect(units.map((u) => u.state)).toEqual(["translate-no", "translate-no"]);
  });

  it("never translates script and style", () => {
    const { units } = extract({ source: doc("<script>var a = 1;</script><p>Hi</p>"), doc: "c1.xhtml" });
    expect(units[0].state).toBe("never-translated");
  });

  it("in the navigation document the leaf is the anchor, not the list item", () => {
    const source = doc(`<nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter One</a></li></ol></nav>`);
    const { units } = extract({ source, doc: "nav.xhtml", nav: true });
    expect(units).toHaveLength(1);
    expect(units[0].source).toBe("Chapter One");
  });

  it("marks a block as code when the stylesheet says its class is a code surface", () => {
    const { units } = extract({
      source: doc(`<p class="listing">gem install foo</p>`),
      doc: "c1.xhtml",
      codeSurfaces: new Set(["listing"]),
    });
    expect(units[0].state).toBe("code");
    expect(units[0].reason).toBe("css-code-surface");
  });

  it("keeps the raw bytes of the range, not the decoded text", () => {
    const { units } = extract({ source: doc("<p>a &#38; b</p>"), doc: "c1.xhtml" });
    expect(units[0].source).toBe("a & b");
    expect(units[0].raw).toBe("a &#38; b");
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/blocks.test.ts`
Atteso: FAIL, `Cannot find module '../epub/blocks.ts'`.

- [ ] **Step 3: Implementare l'estrazione**

Regole, nell'ordine:

1. `BLOCKS` contiene gli elementi di blocco di XHTML: `p div h1 h2 h3 h4 h5 h6 li dt dd blockquote pre figcaption caption td th aside section article header footer nav details summary`. `NAV_BLOCKS` aggiunge `a` e `span`, e vale solo quando `nav` è vero.
2. **Il confine dell'unità segue il modello di contenuto, non il nome del tag.** Nel documento di navigazione un `<li>` ammette solo `a` o `span`, mai testo nudo: con il `<li>` come foglia, una traduzione che lascia una parola fuori dal segnaposto produce un EPUB che EPUBCheck rifiuta, e i livelli di validazione non possono vederlo perché il segnaposto è presente e bilanciato. Prevenzione, non rilevazione: con l'ancora come foglia, la cosa sbagliata smette di essere esprimibile.
3. Un'unità è il blocco **foglia**: un blocco che non ne contiene altri. Un blocco che contiene solo altri blocchi non è un'unità; il testo nudo dentro un contenitore che ha anche figli di blocco è un'unità `kind: "text"` a sé, registrata e non persa.
4. **Ogni blocco foglia con testo diventa un'unità, qualunque sia il suo stato.** L'ordinale — e quindi l'id — dipende da cosa contiene il documento, mai dalla politica di traduzione. Filtrare qui sposterebbe tutti gli id a valle e invaliderebbe lo stato salvato di ogni ripresa.
5. Stato deterministico: `never-translated` per `NEVER_TRANSLATED` (`script`, `style`); `translate-no` se l'elemento o un antenato porta `translate="no"`; `code` per `pre`, `code`, `kbd`, `samp`, `var`, o se una classe dell'elemento è in `codeSurfaces` (con `reason: "css-code-surface"`); `uncomposable` se un evento dell'intervallo è inaffidabile (`reason: "unreliable-range"`); `translate` altrimenti.
6. `raw` è `source.slice(...range)`, cioè i byte, non il testo decodificato: rimetterli a posto tali e quali è ciò che rende esatta l'identità (Task 8).
7. `isWork(state)` è vero per `translate` e `maybe-code`.
8. `skipped` raccoglie i documenti che non si è potuto leggere, con `degraded: true`; un documento saltato per il `translate="no"` dell'autore ha `degraded: false`.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/blocks.test.ts`
Atteso: PASS, sette test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/blocks.ts core/test/blocks.test.ts
git commit -m "feat(epub): every leaf block is a unit, whatever its state"
```

---

### Task 6: Segnaposto inline e attributi traducibili

**Files:**
- Modify: `core/epub/blocks.ts`
- Modify: `core/test/blocks.test.ts`

**Interfaces:**
- Consumes: `extract` (Task 5)
- Produces:

```ts
export interface PlaceholderAttr {
  unitId: string;   // l'unità che porta il valore di questo attributo
  start: number;    // offset del valore dentro `open`, virgolette escluse
  end: number;
}

export interface Placeholder {
  index: number;        // il numero che compare nei marcatori
  open: string;         // tag di apertura, grezzo dal sorgente
  close: string;        // tag di chiusura, grezzo; "" per un elemento vuoto
  opaque: boolean;
  content?: string;     // solo se opaco: contenuto decodificato
  rawContent?: string;  // solo se opaco: il contenuto come lo ha scritto il sorgente
  attrs?: PlaceholderAttr[];
}

export const TRANSLATABLE_ATTRIBUTES: Record<string, string[]>;
```

- [ ] **Step 1: Scrivere i test che falliscono**

Aggiungere a `core/test/blocks.test.ts`:

```ts
describe("inline markup", () => {
  it("masks inline elements as numbered placeholders", () => {
    const { units } = extract({ source: doc("<p>A <em>bold</em> claim</p>"), doc: "c1.xhtml" });
    expect(units[0].source).toBe("A <0>bold</0> claim");
    expect(units[0].placeholders![0].open).toBe("<em>");
    expect(units[0].placeholders![0].close).toBe("</em>");
  });

  it("keeps an empty inline element as a self-contained placeholder", () => {
    const { units } = extract({ source: doc(`<p>Line<br/>break</p>`), doc: "c1.xhtml" });
    expect(units[0].source).toBe("Line<0/>break");
    expect(units[0].placeholders![0].close).toBe("");
  });

  it("keeps the content of an opaque element out of the translation", () => {
    const { units } = extract({ source: doc("<p>Run <code>ls -la</code> now</p>"), doc: "c1.xhtml" });
    expect(units[0].source).toBe("Run <0></0> now");
    expect(units[0].placeholders![0].opaque).toBe(true);
    expect(units[0].placeholders![0].rawContent).toBe("ls -la");
  });

  it("makes a translatable attribute its own unit, owned by the block", () => {
    const { units } = extract({ source: doc(`<p>See <img src="c.png" alt="A cat"/></p>`), doc: "c1.xhtml" });
    const attr = units.find((u) => u.kind === "attribute")!;
    expect(attr.source).toBe("A cat");
    expect(attr.owner).toBe("c1.xhtml#1");
    const ph = units[0].placeholders![0];
    expect(ph.attrs![0].unitId).toBe(attr.id);
    expect(ph.open.slice(ph.attrs![0].start, ph.attrs![0].end)).toBe("A cat");
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/blocks.test.ts`
Atteso: FAIL sui quattro test nuovi, PASS sui sette del Task 5.

- [ ] **Step 3: Implementare i segnaposto**

1. Gli elementi inline dentro un blocco foglia diventano segnaposto numerati da 0, nell'ordine di apertura, nella forma `<0>testo</0>`, oppure `<0/>` se l'elemento è vuoto. Il pattern `<(\/?)(\d+)>` usa solo cifre, quindi non può collidere con markup reale.
2. `OPAQUE` contiene `code`, `kbd`, `samp`, `var`, `tt`: il loro contenuto non entra nella traduzione. Si conservano **due** copie: `content` decodificato e `rawContent` come lo ha scritto il sorgente. `content`, rimesso a posto, verrebbe riescapato e `&#8230;` tornerebbe come puntini letterali — identico per chi legge, diverso per l'invariante I18, che confronta il contenuto opaco byte per byte. Si riemette `rawContent` ogni volta che niente al suo interno deve essere riscritto.
3. `TRANSLATABLE_ATTRIBUTES` mappa il tag agli attributi traducibili: `{ "*": ["title", "aria-label"], img: ["alt"], area: ["alt"], input: ["alt", "placeholder"] }`. Ogni valore diventa un'unità `kind: "attribute"` con `owner` uguale all'id dell'unità blocco che la contiene, e il segnaposto registra `unitId`, `start`, `end` relativi al proprio `open`.
4. La linea è **metadati contro contenuto**: `alt`, `aria-label`, le etichette di nav e NCX e il testo SVG sono contenuto e si traducono; titoli, descrizioni e soggetti del package sono metadati e non si toccano.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/blocks.test.ts`
Atteso: PASS, undici test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/blocks.ts core/test/blocks.test.ts
git commit -m "feat(epub): mask inline markup as placeholders and lift translatable attributes into units"
```

---

### Task 7: Superfici di codice dedotte dai fogli di stile

**Files:**
- Create: `core/epub/css.ts`, `core/test/css.test.ts`

**Interfaces:**
- Consumes: `ZipEntry` (Task 3)
- Produces: `archiveCodeSurfaces(entries: ZipEntry[]): Set<string>` — l'insieme delle **classi** che il CSS del libro tratta come codice, da passare a `extract` come `codeSurfaces`.

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/css.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { archiveCodeSurfaces } from "../epub/css.ts";

const css = (text: string) => [
  { path: "OEBPS/style.css", bytes: Buffer.from(text, "utf8"), compress: true },
];

describe("archiveCodeSurfaces", () => {
  it("takes a class whose font is monospace", () => {
    expect(archiveCodeSurfaces(css(".listing { font-family: monospace; }"))).toContain("listing");
  });

  it("takes a class whose font family names a known monospace face", () => {
    expect(archiveCodeSurfaces(css(".cmd { font-family: 'Courier New', monospace; }"))).toContain("cmd");
  });

  it("ignores a class that merely preserves whitespace", () => {
    expect(archiveCodeSurfaces(css(".poem { white-space: pre; }"))).not.toContain("poem");
  });

  it("ignores css it cannot parse instead of throwing", () => {
    expect(() => archiveCodeSurfaces(css(".broken { font-family"))).not.toThrow();
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/css.test.ts`
Atteso: FAIL, `Cannot find module '../epub/css.ts'`.

- [ ] **Step 3: Implementare**

Scansione testuale dei `.css` dell'archivio, senza un parser CSS completo: per ogni regola, se il blocco di dichiarazioni contiene `font-family` con `monospace` o uno dei nomi noti (`courier`, `consolas`, `menlo`, `monaco`, `dejavu sans mono`, `liberation mono`, `andale mono`), si raccolgono le classi dei selettori della regola, cioè i token che iniziano con un punto.

**`white-space: pre` da solo non basta**: è usato tanto per il codice quanto per la poesia e i testi teatrali, e trattarlo come codice significa non tradurre versi. Il font monospaziato è il segnale che regge.

Il CSS malformato non fa fallire niente: la funzione ignora ciò che non capisce. Questo passaggio è un suggerimento, non un'autorità — decide lo stato iniziale, e il modello (piano 2) potrà contraddirlo.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/css.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/css.ts core/test/css.test.ts
git commit -m "feat(epub): read code surfaces from the stylesheet, monospace only"
```

---

### Task 8: Lo scheletro

**Files:**
- Create: `core/epub/skeleton.ts`, `core/test/skeleton.test.ts`

**Interfaces:**
- Consumes: `TranslationUnit` (Task 5)
- Produces:

```ts
export class SkeletonError extends Error {}
export interface Skeleton { text: string; open: string; close: string }
export interface FillResult { text: string; filled: number }
export function buildSkeleton(source: string, units: TranslationUnit[]): Skeleton;
export function fillSkeleton(
  skeleton: Skeleton,
  units: TranslationUnit[],
  rendered: Map<string, string>,   // id unità → markup già reso (Task 9)
): FillResult;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/skeleton.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extract } from "../epub/blocks.ts";
import { buildSkeleton, fillSkeleton, SkeletonError } from "../epub/skeleton.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>`
  + `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

describe("skeleton", () => {
  it("returns the source byte for byte when nothing is translated", () => {
    const source = doc("<p>One &#38; two</p><pre>x = 1</pre>");
    const { units } = extract({ source, doc: "c1.xhtml" });
    const skeleton = buildSkeleton(source, units);
    const { text, filled } = fillSkeleton(skeleton, units, new Map());
    expect(text).toBe(source);
    expect(filled).toBe(0);
  });

  it("leaves no delimiter behind after a fill", () => {
    const source = doc("<p>One</p>");
    const { units } = extract({ source, doc: "c1.xhtml" });
    const skeleton = buildSkeleton(source, units);
    const { text } = fillSkeleton(skeleton, units, new Map([[units[0].id, "Uno"]]));
    expect(text).not.toContain(skeleton.open);
    expect(text).not.toContain(skeleton.close);
    expect(text).toContain("<p>Uno</p>");
  });

  it("picks a delimiter that does not occur in the source", () => {
    const source = doc("<p>A ⟦u: literal ⟧ in the text</p>");
    const { units } = extract({ source, doc: "c1.xhtml" });
    const skeleton = buildSkeleton(source, units);
    expect(skeleton.open).not.toBe("⟦u:");
  });

  it("refuses units whose ranges do not describe this source", () => {
    const source = doc("<p>One</p>");
    const { units } = extract({ source, doc: "c1.xhtml" });
    const stale = units.map((u) => ({ ...u, range: [9_000, 9_100] as [number, number] }));
    expect(() => buildSkeleton(source, stale)).toThrow(SkeletonError);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/skeleton.test.ts`
Atteso: FAIL, `Cannot find module '../epub/skeleton.ts'`.

- [ ] **Step 3: Implementare**

1. **Scelta del delimitatore.** Tre coppie candidate, in ordine: prima `⟦u:` con `⟧`, poi `⦃u:` con `⦄`, e come ultima risorsa la coppia formata dal carattere di controllo SOH (U+0001) seguito da `u:` e dal carattere STX (U+0002) — caratteri che nessun documento XHTML porta legittimamente. Vince la prima coppia assente dal sorgente; se occorrono tutte, `SkeletonError`. È l'unico rischio che questo disegno aggiunge rispetto allo scrivere per offset, e per questo il delimitatore si verifica contro il sorgente invece di darlo per buono.
2. **Solo le unità radice** ricevono un segnaposto: l'intervallo di un'unità figlia (un attributo) sta *dentro* quello del suo proprietario, e darle un segnaposto proprio significherebbe annidarne uno dentro l'altro. Si filtra su `owner` assente e si ordina per inizio dell'intervallo.
3. **Le unità devono descrivere questo sorgente.** Se un intervallo è invertito, esce dai limiti del sorgente o si sovrappone al precedente, si lancia `SkeletonError` nominando l'unità. Uno `units` stale — di un altro libro, o di prima che un confine si spostasse — con `slice` risponderebbe con il silenzio: una stringa vuota qui, una troncata là, e un documento ricostruito male senza che nulla lo dica.
4. **Il riempimento salta le unità la cui resa coincide con l'originale**, riemettendo `raw`. Non è un'ottimizzazione: è ciò che rende l'output a traduzione nulla identico byte per byte, e quindi il gate un'asserzione vera invece di una tautologia. Riscrivendo ogni intervallo, il riescape trasformerebbe `&#38;` in `&amp;` — identico per chi legge, diverso per il confronto — e il gate andrebbe indebolito a un paragone semantico.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/skeleton.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/skeleton.ts core/test/skeleton.test.ts
git commit -m "feat(epub): take every unit out and put it back, so identity is asserted"
```

---

### Task 9: Resa di una singola unità

**Files:**
- Create: `core/epub/splice.ts`, `core/test/splice.test.ts`

**Interfaces:**
- Consumes: `Placeholder`, `TranslationUnit` (Task 5-6), `escapeAttr`, `escapeText` (Task 4)
- Produces: `render(unit: TranslationUnit, translation: string, translatedAttrs?: Map<string, string>): string` — dal testo tradotto con i segnaposto al markup finale. Lancia `SpliceError` se un segnaposto è sconosciuto o sbilanciato.

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/splice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extract } from "../epub/blocks.ts";
import { render } from "../epub/splice.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?>`
  + `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

describe("render", () => {
  it("puts the original tags back where the placeholders are", () => {
    const { units } = extract({ source: doc("<p>A <em>bold</em> claim</p>"), doc: "c1.xhtml" });
    expect(render(units[0], "Una <0>audace</0> affermazione")).toBe("Una <em>audace</em> affermazione");
  });

  it("re-emits opaque content from the raw source, not from the decoded text", () => {
    const { units } = extract({ source: doc("<p>Run <code>a &#38; b</code> now</p>"), doc: "c1.xhtml" });
    expect(render(units[0], "Esegui <0></0> ora")).toBe("Esegui <code>a &#38; b</code> ora");
  });

  it("splices a translated attribute into its recorded offsets", () => {
    const { units } = extract({ source: doc(`<p>See <img src="c.png" alt="A cat"/></p>`), doc: "c1.xhtml" });
    const attr = units.find((u) => u.kind === "attribute")!;
    const out = render(units[0], "Vedi <0/>", new Map([[attr.id, "Un gatto"]]));
    expect(out).toBe(`Vedi <img src="c.png" alt="Un gatto"/>`);
  });

  it("refuses a translation that names a placeholder the unit does not have", () => {
    const { units } = extract({ source: doc("<p>Plain</p>"), doc: "c1.xhtml" });
    expect(() => render(units[0], "Testo <7>ignoto</7>")).toThrow();
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/splice.test.ts`
Atteso: FAIL, `Cannot find module '../epub/splice.ts'`.

- [ ] **Step 3: Implementare**

1. Il testo fuori dai segnaposto passa da `escapeText`; i tag vengono riemessi **grezzi** dal segnaposto (`open`, `close`).
2. **Ogni funzione crea la propria istanza del regex** `/<(\/?)(\d+)>/g`: il `lastIndex` di un regex condiviso resta appeso quando si esce dal ciclo con un errore, e avvelena l'unità successiva.
3. Per un segnaposto opaco si riemette `rawContent`, non `content`, a meno che qualcosa di annidato al suo interno non abbia un attributo tradotto. Il contenuto tenuto in `content` non è markup grezzo: un opaco annidato vi compare con i propri marcatori numerici, che vanno risolti ricorsivamente sulla stessa tabella, e il testo tra i marcatori di un opaco interno è una copia del suo stesso `content` — va saltato, o verrebbe emesso due volte.
4. Gli attributi tradotti si innestano negli offset registrati **lavorando all'indietro**, dal maggiore al minore, così gli offset non ancora usati restano validi.
5. Un segnaposto sconosciuto, sbilanciato o duplicato è un errore: nel piano 2 diventa una diagnosi che torna al modello con la richiesta di riprovare.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/splice.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/splice.ts core/test/splice.test.ts
git commit -m "feat(epub): resolve placeholders back into the source's own tags"
```

---

### Task 10: Il documento di package

**Files:**
- Create: `core/epub/package.ts`, `core/test/package.test.ts`

**Interfaces:**
- Consumes: `scan` (Task 4), `ZipEntry` (Task 3)
- Produces:

```ts
export interface ManifestItem {
  id: string; href: string; mediaType: string;
  properties?: string; mediaOverlay?: string;
}
export interface SpineItem { idref: string; linear: boolean; properties?: string }
export interface PackageDoc {
  path: string;                 // percorso dell'OPF nell'archivio
  uniqueIdentifier: string;     // il dc:identifier indicato da unique-identifier
  language: string;
  title: string;
  author?: string;
  manifest: ManifestItem[];
  spine: SpineItem[];
  source: string;               // l'OPF come testo
}
export function findPackagePath(entries: ZipEntry[]): string;   // via META-INF/container.xml
export function readPackage(entries: ZipEntry[]): PackageDoc;
export function writeLanguage(opf: string, language: string, modified: Date): string;
export function writeRootLang(xhtml: string, language: string): string;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/package.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { readPackage, writeLanguage, writeRootLang } from "../epub/package.ts";

describe("readPackage", () => {
  it("reads identifier, language, manifest and spine", async () => {
    const bytes = await buildEpub({
      language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }],
    });
    const pkg = readPackage((await readEpub(bytes)).entries);
    expect(pkg.language).toBe("en");
    expect(pkg.uniqueIdentifier).toBe("urn:uuid:11111111-2222-3333-4444-555555555555");
    expect(pkg.spine.length).toBeGreaterThan(0);
  });
});

describe("writeLanguage", () => {
  it("rewrites dc:language and dcterms:modified, and leaves the identifier alone", async () => {
    const bytes = await buildEpub({ language: "en", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    const pkg = readPackage((await readEpub(bytes)).entries);
    const out = writeLanguage(pkg.source, "it", new Date("2026-08-24T10:00:00Z"));
    expect(out).toContain("<dc:language>it</dc:language>");
    expect(out).toContain("2026-08-24T10:00:00Z");
    expect(out).toContain(pkg.uniqueIdentifier);
  });
});

describe("writeRootLang", () => {
  it("rewrites a regional tag whose primary subtag matches the source language", () => {
    const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en-US" lang="en-US"><body/></html>`;
    const out = writeRootLang(xhtml, "it");
    expect(out).toContain(`xml:lang="it"`);
    expect(out).toContain(`lang="it"`);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/package.test.ts`
Atteso: FAIL, `Cannot find module '../epub/package.ts'`.

- [ ] **Step 3: Implementare**

1. `findPackagePath` legge `META-INF/container.xml` e prende il `full-path` del primo `<rootfile>`.
2. `readPackage` scansiona l'OPF e ricava `unique-identifier`, il `dc:identifier` corrispondente, `dc:language`, `dc:title`, `dc:creator`, il manifest (con `media-overlay` quando c'è) e la spine.
3. **I metadati del package sono in sola lettura tranne `dc:language` e `dcterms:modified`.** `dc:identifier` in particolare è immutabile: è la chiave da cui si deriva l'offuscamento dei font, e cambiarlo li corrompe in silenzio — EPUBCheck non lo prende, perché `RSC-004` salta il contenuto delle risorse cifrate. Titoli, descrizioni e soggetti non si traducono.
4. `writeRootLang` confronta le lingue **per sottotag primario**, non come stringhe esatte. Un package che dichiara `en-us` mentre il documento porta `en` è un caso reale, trovato su libri veri: col confronto esatto il documento resta intatto e l'invariante sulla lingua fallisce a fine corsa.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/package.test.ts`
Atteso: PASS, tre test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/package.ts core/test/package.test.ts
git commit -m "feat(epub): read the package and rewrite only the two fields we may touch"
```

---

### Task 11: Rimozione dei media overlay

**Files:**
- Create: `core/epub/overlay.ts`, `core/test/overlay.test.ts`
- Modify: `core/test/corpus/build.ts` (nuovo campo `overlays`)

**Interfaces:**
- Consumes: `ZipEntry` (Task 3), `findPackagePath` (Task 10)
- Produces:

```ts
export interface OverlayRemoval {
  entries: ZipEntry[];   // l'archivio senza SMIL e senza audio orfano
  opf: string;           // l'OPF ripulito
  removed: { overlays: number; audio: number };
}
export function hasOverlays(entries: ZipEntry[]): boolean;
export function removeOverlays(entries: ZipEntry[], opfPath: string): OverlayRemoval;
```

- [ ] **Step 1: Estendere il generatore di fixture**

Aggiungere a `EpubSpec` il campo `overlays?: Array<{ smilPath: string; audioPath: string; forDocument: string; duration: string }>`. Quando è presente, `buildEpub` scrive: il file SMIL con `<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq><par><text src="…#p1"/><audio src="…" clipBegin="0:00:00" clipEnd="0:00:05"/></par></seq></body></smil>`, un file audio finto, l'`<item>` di entrambi nel manifest, l'attributo `media-overlay` sull'`<item>` del documento di contenuto, un `<meta property="media:duration" refines="#…">` per overlay più un `media:duration` totale, e `<meta property="media:narrator">Voice</meta>`.

- [ ] **Step 2: Scrivere i test che falliscono**

`core/test/overlay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { findPackagePath } from "../epub/package.ts";
import { hasOverlays, removeOverlays } from "../epub/overlay.ts";

async function withOverlay() {
  const bytes = await buildEpub({
    documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi</p>` }],
    overlays: [{
      smilPath: "OEBPS/c1.smil", audioPath: "OEBPS/c1.mp3",
      forDocument: "OEBPS/c1.xhtml", duration: "0:00:05",
    }],
  });
  const epub = await readEpub(bytes);
  return { epub, opfPath: findPackagePath(epub.entries) };
}

describe("removeOverlays", () => {
  it("finds the overlays before removing them", async () => {
    const { epub } = await withOverlay();
    expect(hasOverlays(epub.entries)).toBe(true);
  });

  it("removes smil files, the media-overlay attribute and the media metadata", async () => {
    const { epub, opfPath } = await withOverlay();
    const out = removeOverlays(epub.entries, opfPath);
    expect(out.entries.some((e) => e.path.endsWith(".smil"))).toBe(false);
    expect(out.opf).not.toContain("media-overlay");
    expect(out.opf).not.toContain("media:duration");
    expect(out.opf).not.toContain("media:narrator");
    expect(out.removed).toEqual({ overlays: 1, audio: 1 });
  });

  it("keeps the element ids the overlays pointed at", async () => {
    const { epub, opfPath } = await withOverlay();
    const out = removeOverlays(epub.entries, opfPath);
    const c1 = out.entries.find((e) => e.path === "OEBPS/c1.xhtml")!;
    expect(c1.bytes.toString("utf8")).toContain(`id="p1"`);
  });

  it("keeps audio a content document references on its own", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi</p><audio src="song.mp3"/>` }],
      extra: [{ path: "OEBPS/song.mp3", bytes: Buffer.from("fake") }],
      overlays: [{
        smilPath: "OEBPS/c1.smil", audioPath: "OEBPS/c1.mp3",
        forDocument: "OEBPS/c1.xhtml", duration: "0:00:05",
      }],
    });
    const epub = await readEpub(bytes);
    const out = removeOverlays(epub.entries, findPackagePath(epub.entries));
    expect(out.entries.some((e) => e.path === "OEBPS/song.mp3")).toBe(true);
    expect(out.removed.audio).toBe(1);
  });

  it("leaves an archive without overlays exactly as it was", async () => {
    const bytes = await buildEpub({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    const epub = await readEpub(bytes);
    const out = removeOverlays(epub.entries, findPackagePath(epub.entries));
    expect(out.entries).toEqual(epub.entries);
    expect(out.removed).toEqual({ overlays: 0, audio: 0 });
  });
});
```

- [ ] **Step 3: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/overlay.test.ts`
Atteso: FAIL, `Cannot find module '../epub/overlay.ts'`.

- [ ] **Step 4: Implementare la rimozione**

Un audio nella lingua di partenza sotto un testo tradotto non serve a nessuno, e trascinarlo significa portarsi dietro decine o centinaia di megabyte inutilizzabili. La rimozione è **atomica su cinque punti**, tutti insieme o nessuno:

1. gli `<item>` dei file SMIL escono dal manifest e i file escono dall'archivio;
2. l'attributo `media-overlay` sparisce dagli `<item>` che lo portavano;
3. escono i metadati che esistono solo per gli overlay: i `media:duration` con `refines`, il `media:duration` totale, `media:narrator`, `media:active-class`, `media:playback-active-class`;
4. escono le risorse audio che, tolti gli SMIL, non sono più referenziate da **nessun** documento di contenuto — solo quelle: un `<audio>` scritto nel testo è contenuto del libro e resta;
5. **gli id degli elementi restano dove sono.** Erano il bersaglio degli overlay, ma sono anche il bersaglio dei link interni: toglierli romperebbe la navigazione.

Una rimozione a metà è peggio di nessuna rimozione: EPUBCheck rifiuta un `media-overlay` che punta a un item inesistente, e un `media:duration` orfano fa scattare `MED-016`. L'invariante I22 (Task 14) lo verifica.

- [ ] **Step 5: Eseguire i test**

Run: `npx vitest run core/test/overlay.test.ts`
Atteso: PASS, cinque test.

- [ ] **Step 6: Commit**

```bash
git add core/epub/overlay.ts core/test/overlay.test.ts core/test/corpus/build.ts
git commit -m "feat(epub): remove media overlays whole, or not at all"
```

---

### Task 12: Rilevamento dell'impaginazione fissa

**Files:**
- Create: `core/epub/layout.ts`, `core/test/layout.test.ts`
- Modify: `core/test/corpus/build.ts` (il campo `layout` sui documenti, già previsto nel Task 2)

**Interfaces:**
- Consumes: `PackageDoc` (Task 10)
- Produces:

```ts
export type Layout = "reflowable" | "pre-paginated";
export interface LayoutReport {
  book: Layout | "mixed";
  byDocument: Record<string, Layout>;   // href del documento → layout effettivo
  prePaginated: number;                 // quanti documenti sono pre-paginati
}
export function detectLayout(pkg: PackageDoc): LayoutReport;
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { readPackage } from "../epub/package.ts";
import { detectLayout } from "../epub/layout.ts";

async function layoutOf(spec: Parameters<typeof buildEpub>[0]) {
  const epub = await readEpub(await buildEpub(spec));
  return detectLayout(readPackage(epub.entries));
}

describe("detectLayout", () => {
  it("calls a book reflowable when nothing says otherwise", async () => {
    const report = await layoutOf({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }] });
    expect(report.book).toBe("reflowable");
    expect(report.prePaginated).toBe(0);
  });

  it("reads the package-level property", async () => {
    const report = await layoutOf({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Hi</p>" }],
      packageProperties: `<meta property="rendition:layout">pre-paginated</meta>`,
    });
    expect(report.book).toBe("pre-paginated");
    expect(report.prePaginated).toBe(1);
  });

  it("lets a spine item override the package", async () => {
    const report = await layoutOf({
      documents: [
        { path: "OEBPS/c1.xhtml", xhtml: "<p>Text</p>" },
        { path: "OEBPS/plate.xhtml", xhtml: "<p>Plate</p>", layout: "pre-paginated" },
      ],
    });
    expect(report.book).toBe("mixed");
    expect(report.byDocument["OEBPS/plate.xhtml"]).toBe("pre-paginated");
    expect(report.prePaginated).toBe(1);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/layout.test.ts`
Atteso: FAIL, `Cannot find module '../epub/layout.ts'`.

- [ ] **Step 3: Implementare**

`rendition:layout` compare a **due livelli** e vanno controllati entrambi: la `<meta property="rendition:layout">` nel package, e la sovrascrittura per singolo `<itemref>` tramite `properties="rendition:layout-pre-paginated"` o `rendition:layout-reflowable`. Il default del package, se manca, è `reflowable`. Un libro con documenti di entrambi i tipi è `mixed`.

Il generatore di fixture, quando un documento ha `layout: "pre-paginated"`, deve scrivere sia la proprietà sull'`itemref` sia il meta `viewport` con `width` e `height` nel documento: senza il viewport EPUBCheck emette `HTM_046`, e con una sola delle due dimensioni `HTM_056`.

**A cosa serve.** La traduzione allunga il testo tra il 15% e il 35% verso le lingue romanze e germaniche. Dove il testo scorre non succede niente; dove è posizionato in modo assoluto dentro un viewport a pixel fissi, la frase più lunga esce dalla sua scatola. Nessun controllo automatico lo vede — EPUBCheck non renderizza, e l'overflow non viola la specifica. Questo rilevamento non risolve il problema: lo rende dicibile, così l'interfaccia può avvisare prima che l'utente spenda.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/layout.test.ts`
Atteso: PASS, tre test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/layout.ts core/test/layout.test.ts core/test/corpus/build.ts
git commit -m "feat(epub): detect fixed layout at both levels it can be declared"
```

---

### Task 13: Il modello del libro, con un parser indipendente

**Files:**
- Create: `core/epub/inspect.ts`, `core/test/inspect.test.ts`

**Interfaces:**
- Consumes: `ZipEntry` (Task 3)
- Produces:

```ts
export interface NavEntry { label: string; href: string; depth: number }
export interface GuideRef { type: string; title: string; href: string }
export interface EpubModel {
  opfPath: string;
  resourcePaths: string[];              // ordinati
  binaryHashes: Record<string, string>; // percorso → sha256, solo risorse non testuali
  manifest: string;                     // forma canonica, confrontabile
  spine: string;                        // forma canonica, confrontabile
  elementIds: Record<string, string[]>; // documento → id, in ordine
  internalLinks: Array<{ from: string; href: string }>;
  nav: NavEntry[];
  guide: GuideRef[];
  spineToc: string | null;
  languages: Record<string, string>;    // documento → xml:lang radice
  uniqueIdentifier: string;
  opfAttributes: string;                // gli attributi opf:* nell'ordine in cui compaiono
  overlays: { smil: string[]; mediaAttributes: number; mediaMetadata: number };
  mimetypeConformant: boolean;
}
export function inspect(entries: ZipEntry[]): EpubModel;
```

- [ ] **Step 1: Scrivere il test che fallisce**

`core/test/inspect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { inspect } from "../epub/inspect.ts";

describe("inspect", () => {
  it("describes the book without using the scanner the pipeline transforms with", async () => {
    const bytes = await buildEpub({
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi <a href="c2.xhtml">there</a></p>` }],
    });
    const model = inspect((await readEpub(bytes)).entries);
    expect(model.elementIds["OEBPS/c1.xhtml"]).toEqual(["p1"]);
    expect(model.internalLinks).toContainEqual({ from: "OEBPS/c1.xhtml", href: "c2.xhtml" });
    expect(model.mimetypeConformant).toBe(true);
    expect(model.nav.length).toBeGreaterThan(0);
  });

  it("does not import the pipeline scanner", async () => {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile("core/epub/inspect.ts", "utf8");
    expect(text).not.toContain("./scan.ts");
    expect(text).not.toContain("saxes");
  });
});
```

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

Run: `npx vitest run core/test/inspect.test.ts`
Atteso: FAIL, `Cannot find module '../epub/inspect.ts'`.

- [ ] **Step 3: Implementare con un walker XML minimale, scritto qui**

**`inspect.ts` non deve condividere il parser con `blocks.ts` e `splice.ts`.** Se il codice che verifica e quello che trasforma condividono le assunzioni, un difetto del parser è simmetrico e quindi invisibile a un confronto prima/dopo: il difetto si nasconde da solo. Il walker duplicato qui è deliberato, e il secondo test lo fa rispettare.

Il walker deve solo attraversare tag e testo: riconoscere apertura, chiusura, elemento vuoto, commento, CDATA e istruzione di elaborazione, e leggere gli attributi. Non serve validazione, non serve namespace: serve indipendenza.

`manifest` e `spine` sono stringhe canoniche (righe ordinate `id|href|media-type|properties`) perché il confronto tra prima e dopo sia una differenza di testo leggibile invece di un confronto di oggetti.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/inspect.test.ts`
Atteso: PASS, due test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/inspect.ts core/test/inspect.test.ts
git commit -m "feat(epub): describe the book with a walker that shares nothing with the transformer"
```

---

### Task 14: Le invarianti

**Files:**
- Create: `core/epub/invariants.ts`, `core/test/invariants.test.ts`

**Interfaces:**
- Consumes: `EpubModel` (Task 13), `TranslationUnit` (Task 5)
- Produces:

```ts
export interface InvariantResult { id: string; name: string; ok: boolean; details: string[]; skipped?: boolean }
export interface CheckInput {
  before: EpubModel;
  after: EpubModel;
  units: TranslationUnit[];
  distrusted: number;                                        // unità con intervallo inaffidabile
  skippedDocs: Array<{ path: string; reason: string }>;
  targetLanguage: string;
  overlaysRemoved: { overlays: number; audio: number } | null;
  skeletonIdentity: boolean;                                 // il riempimento nullo ha reso l'originale
}
export function checkInvariants(input: CheckInput): InvariantResult[];
```

L'elenco completo, che è anche il contratto verso il piano 4:

| Id | Nome |
|---|---|
| I1 | same set of resources |
| I2 | binary resources unchanged |
| I3 | manifest unchanged |
| I4 | spine unchanged |
| I5 | element ids unchanged |
| I6 | internal links resolvable |
| I7 | navigation hierarchy |
| I8 | unique identifier unchanged |
| I9 | identity metadata unchanged |
| I10 | opf:* attributes preserved |
| I11 | EPUB 2 guide preserved |
| I12 | documents reparseable |
| I13 | mimetype conformant |
| I14 | OPF path unchanged |
| I15 | no discarded units |
| I16 | no skipped documents |
| I17 | placeholders preserved |
| I18 | opaque content unchanged |
| I19 | language consistent |
| I20 | unit coverage |
| I21 | skeleton round-trips |
| I22 | overlays removed whole |

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/invariants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { inspect } from "../epub/inspect.ts";
import { checkInvariants } from "../epub/invariants.ts";

async function model(spec: Parameters<typeof buildEpub>[0]) {
  return inspect((await readEpub(await buildEpub(spec))).entries);
}

const base = { documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi</p>` }], language: "en" };

describe("checkInvariants", () => {
  it("passes when the book is compared with itself", async () => {
    const m = await model(base);
    const results = checkInvariants({
      before: m, after: m, units: [], distrusted: 0, skippedDocs: [],
      targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
    });
    expect(results.filter((r) => !r.ok && !r.skipped)).toEqual([]);
    expect(results.map((r) => r.id)).toContain("I22");
  });

  it("declares an invariant skipped instead of faking a pass", async () => {
    const m = await model(base);
    const results = checkInvariants({
      before: m, after: m, units: [], distrusted: 0, skippedDocs: [],
      targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
    });
    expect(results.find((r) => r.id === "I11")?.skipped).toBe(true);
  });

  it("fails I8 when the unique identifier changed", async () => {
    const before = await model(base);
    const after = await model({ ...base, identifier: "urn:uuid:99999999-9999-9999-9999-999999999999" });
    const results = checkInvariants({
      before, after, units: [], distrusted: 0, skippedDocs: [],
      targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
    });
    expect(results.find((r) => r.id === "I8")?.ok).toBe(false);
  });

  it("fails I15 when a unit was discarded for an unreliable range", async () => {
    const m = await model(base);
    const results = checkInvariants({
      before: m, after: m, units: [], distrusted: 2, skippedDocs: [],
      targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
    });
    expect(results.find((r) => r.id === "I15")?.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/invariants.test.ts`
Atteso: FAIL, `Cannot find module '../epub/invariants.ts'`.

- [ ] **Step 3: Implementare**

Ogni invariante restituisce `ok` più `details` che nominano la differenza: un'invariante che dice solo "fallita" costringe a rifare l'indagine a mano.

Tre punti che cambiano il comportamento:

- **`skipped` invece di un falso passaggio.** I11 non si applica a un EPUB 3 senza guide: si dichiara saltata. Un'invariante che passa perché non aveva niente da controllare mente sul valore della suite.
- **I17 non può usare l'intervallo dell'unità sul documento dopo.** Gli intervalli sono offset nel documento *prima*; nel dopo, ogni unità riscritta cambia lunghezza e sposta tutto ciò che segue. La finestra va ricalcolata sul documento dopo, o il confronto taglia dentro i tag di chiusura.
- **I22 è nuova rispetto al prototipo**: verifica che dopo la rimozione degli overlay non resti nessun file SMIL, nessun attributo `media-overlay`, nessun metadato `media:*`, e che il conteggio dichiarato corrisponda a ciò che è effettivamente sparito. Quando il libro non aveva overlay, l'invariante passa e non è saltata: "non c'era niente da rimuovere, e infatti non c'è niente" è un'asserzione vera.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/invariants.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/invariants.ts core/test/invariants.test.ts
git commit -m "feat(epub): twenty-two invariants that name the difference they found"
```

---

### Task 15: I sabotaggi

**Files:**
- Create: `core/test/corpus/sabotage.ts`, `core/test/sabotage.test.ts`

**Interfaces:**
- Consumes: tutto il layer
- Produces:

```ts
export interface Sabotage {
  name: string;
  description: string;
  /** Almeno una di queste invarianti DEVE fallire. */
  trips: string[];
  apply(entries: ZipEntry[], units: TranslationUnit[]): Promise<ZipEntry[]>;
}
export const SABOTAGES: Sabotage[];
```

**Perché esistono.** Una suite che non è mai fallita non ha dimostrato di poter fallire. Ogni invariante ha bisogno di un controllo negativo: un difetto costruito apposta che la faccia scattare. Se un sabotaggio passa indenne, è rotta l'invariante, non il sabotaggio. Nel prototipo questo ha scoperto due invarianti morte — un'eccezione opaca che mascherava il controllo di riparsing, e un'invariante di packaging irraggiungibile attraverso il nostro stesso scrittore, perché lo scrittore correggeva la condizione che avrebbe dovuto rilevare (di qui l'opzione `conformant: false` del Task 3).

- [ ] **Step 1: Scrivere il test che fallisce**

`core/test/sabotage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import { readEpub } from "../epub/zip.ts";
import { inspect } from "../epub/inspect.ts";
import { extract } from "../epub/blocks.ts";
import { checkInvariants } from "../epub/invariants.ts";
import { SABOTAGES } from "./corpus/sabotage.ts";

describe("sabotages", () => {
  it.each(SABOTAGES.map((s) => [s.name, s] as const))(
    "%s trips the invariants it claims to trip",
    async (_name, sabotage) => {
      const bytes = await buildEpub({
        documents: [{
          path: "OEBPS/c1.xhtml",
          xhtml: `<p id="p1">A <em>bold</em> claim with <code>ls</code> and <img src="c.png" alt="A cat"/></p>`,
        }],
      });
      const epub = await readEpub(bytes);
      const before = inspect(epub.entries);
      const source = epub.get("OEBPS/c1.xhtml")!.toString("utf8");
      const { units } = extract({ source, doc: "OEBPS/c1.xhtml" });

      const damaged = await sabotage.apply(epub.entries, units);
      const results = checkInvariants({
        before, after: inspect(damaged), units, distrusted: 0, skippedDocs: [],
        targetLanguage: "en", overlaysRemoved: null, skeletonIdentity: true,
      });

      const failed = results.filter((r) => !r.ok).map((r) => r.id);
      expect(failed.some((id) => sabotage.trips.includes(id))).toBe(true);
    },
  );
});
```

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

Run: `npx vitest run core/test/sabotage.test.ts`
Atteso: FAIL, `Cannot find module './corpus/sabotage.ts'`.

- [ ] **Step 3: Scrivere i dodici sabotaggi**

| Nome | Cosa fa | Deve far scattare |
|---|---|---|
| `naive-regex` | traduce con una sostituzione testuale che mangia i tag | I17, I5 |
| `renumber-ids` | rinumera gli `id` degli elementi | I5, I6 |
| `new-identifier` | conia un nuovo `dc:identifier` per l'edizione tradotta | I8, I9 |
| `drop-placeholder` | omette un segnaposto dalla resa | I17 |
| `drop-attributed-tag` | rimuove un tag che portava un attributo tradotto | I5, I17 |
| `translate-opaque` | traduce il contenuto di un elemento opaco | I18 |
| `empty-nav-label` | svuota un'etichetta della navigazione | I7 |
| `rezip-naive` | riscrive lo zip con `conformant: false`, `mimetype` non per primo | I13 |
| `swap-block-range` | scambia gli intervalli di due unità | I17, I20 |
| `reserialize` | riserializza il documento con un parser che normalizza tag e attributi | I2, I12 |
| `orphan-placeholder` | lascia un marcatore numerico nell'output | I17 |
| `half-removed-overlay` | toglie i file SMIL ma lascia `media-overlay` e `media:duration` | I22 |

Ogni sabotaggio è una funzione pura da `entries` a `entries`: prende l'archivio, lo guasta in un punto solo, e restituisce l'archivio guasto.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/sabotage.test.ts`
Atteso: PASS, dodici casi.

**Se un caso fallisce, l'invariante è rotta, non il sabotaggio.** Va corretta l'invariante prima di andare avanti.

- [ ] **Step 5: Commit**

```bash
git add core/test/corpus/sabotage.ts core/test/sabotage.test.ts
git commit -m "test: twelve sabotages, one negative control per invariant that has one"
```

---

### Task 16: EPUBCheck, quando c'è

**Files:**
- Create: `core/epub/epubcheck.ts`, `core/test/epubcheck.test.ts`

**Interfaces:**
- Consumes: niente
- Produces:

```ts
export interface EpubcheckMessage { id: string; severity: "fatal" | "error" | "warning" | "usage"; message: string; path?: string }
export interface EpubcheckResult {
  ran: boolean;
  reason?: "no-jar" | "no-java" | "crashed";   // codice, non frase
  messages: EpubcheckMessage[];
}
export function findJar(env: NodeJS.ProcessEnv, cwd: string): string | null;
export function runEpubcheck(epubPath: string, env?: NodeJS.ProcessEnv): Promise<EpubcheckResult>;
export function introducedMessages(before: EpubcheckResult, after: EpubcheckResult): EpubcheckMessage[];
```

- [ ] **Step 1: Scrivere i test che falliscono**

`core/test/epubcheck.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findJar, introducedMessages, runEpubcheck } from "../epub/epubcheck.ts";

describe("findJar", () => {
  it("prefers the jar the environment names", () => {
    expect(findJar({ EPUBCHECK_JAR: "/opt/ec.jar" }, "/work")).toBe("/opt/ec.jar");
  });

  it("returns null when the named jar is absent, without falling back", () => {
    expect(findJar({ EPUBCHECK_JAR: "/nope/missing.jar" }, "/work")).toBeNull();
  });
});

describe("runEpubcheck", () => {
  it("says it did not run instead of pretending it passed", async () => {
    const result = await runEpubcheck("/tmp/whatever.epub", { EPUBCHECK_JAR: "/nope/missing.jar" });
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("no-jar");
    expect(result.messages).toEqual([]);
  });
});

describe("introducedMessages", () => {
  it("blames only what the run introduced", () => {
    const before = { ran: true, messages: [{ id: "RSC-005", severity: "error" as const, message: "old" }] };
    const after = {
      ran: true,
      messages: [
        { id: "RSC-005", severity: "error" as const, message: "old" },
        { id: "MED-016", severity: "error" as const, message: "new" },
      ],
    };
    expect(introducedMessages(before, after).map((m) => m.id)).toEqual(["MED-016"]);
  });
});
```

- [ ] **Step 2: Eseguirli e verificare che falliscano**

Run: `npx vitest run core/test/epubcheck.test.ts`
Atteso: FAIL, `Cannot find module '../epub/epubcheck.ts'`.

- [ ] **Step 3: Implementare**

1. Il jar si cerca in `$EPUBCHECK_JAR` se impostata, altrimenti in `vendor/epubcheck/epubcheck.jar` relativo alla directory di lavoro. **Un jar nominato dalla variabile d'ambiente è autoritativo**: se non c'è, il controllo non viene eseguito e non si ripiega su quello vendorizzato — chi ha indicato un jar preciso vuole quello.
2. `vendor/` è gitignorato, quindi su un clone fresco il jar **manca** e il gate degrada a "non eseguito". Lo deve dire, e non deve mai fingere un passaggio. Per installarlo:

```bash
curl -sSL -o ec.zip https://github.com/w3c/epubcheck/releases/download/v5.3.0/epubcheck-5.3.0.zip
unzip -q ec.zip -d vendor/epubcheck && mv vendor/epubcheck/epubcheck-5.3.0/* vendor/epubcheck/
```

3. Si esegue con `java -jar <jar> --json -` e si legge il JSON; serve una JVM. Assenza di `java`, uscita anomala o JSON illeggibile diventano `ran: false` con il `reason` corrispondente, mai un errore che ferma la pipeline.
4. `introducedMessages` confronta prima e dopo: **un libro può arrivare già non conforme**, e attribuire alla traduzione un difetto che c'era prima è un'accusa falsa che fa perdere ore.

- [ ] **Step 4: Eseguire i test**

Run: `npx vitest run core/test/epubcheck.test.ts`
Atteso: PASS, quattro test.

- [ ] **Step 5: Commit**

```bash
git add core/epub/epubcheck.ts core/test/epubcheck.test.ts
git commit -m "feat(epub): run EPUBCheck when it is there, and say so when it is not"
```

---

### Task 17: Superficie pubblica e identità end-to-end

**Files:**
- Create: `core/epub/index.ts`, `core/test/identity.test.ts`

**Interfaces:**
- Consumes: tutti i moduli precedenti
- Produces: `core/epub/index.ts`, l'unico punto da cui i piani 2, 3 e 4 importano.

- [ ] **Step 1: Scrivere il test che fallisce**

`core/test/identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEpub } from "./corpus/build.ts";
import {
  archiveCodeSurfaces, buildSkeleton, extract, fillSkeleton,
  findPackagePath, inspect, readEpub, readPackage, writeEpub,
} from "../epub/index.ts";

const FIXTURES = [
  { name: "prose", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><p>Two &#38; three</p>" }] },
  { name: "inline", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>A <em>bold</em> <code>ls -la</code> claim</p>" }] },
  { name: "attributes", documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p>See <img src="c.png" alt="A cat" title="Cat"/></p>` }] },
  { name: "entities", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>&copy; 2026 &hellip; &#8212;</p>" }] },
  { name: "nested-blocks", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<div><blockquote><p>Deep</p></blockquote>loose text</div>" }] },
  { name: "table", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<table><tr><td>Cell</td><th>Head</th></tr></table>" }] },
  { name: "translate-no", documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p translate="no">Brand</p><p>Text</p>` }] },
  { name: "pre-paginated", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Plate</p>", layout: "pre-paginated" as const }] },
  { name: "two-documents", documents: [
    { path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" },
    { path: "OEBPS/c2.xhtml", xhtml: "<p>Two</p>" },
  ] },
];

describe("identity", () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    "%s: an empty fill returns every document byte for byte",
    async (_name, fixture) => {
      const epub = await readEpub(await buildEpub(fixture));
      const surfaces = archiveCodeSurfaces(epub.entries);
      const pkg = readPackage(epub.entries);

      for (const item of pkg.manifest.filter((m) => m.mediaType === "application/xhtml+xml")) {
        const path = item.href.includes("/") ? item.href : `OEBPS/${item.href}`;
        const source = epub.get(path)!.toString("utf8");
        const { units } = extract({ source, doc: path, codeSurfaces: surfaces, nav: path.endsWith("nav.xhtml") });
        const skeleton = buildSkeleton(source, units);
        expect(fillSkeleton(skeleton, units, new Map()).text).toBe(source);
      }
    },
  );

  it("rewrites nothing in the archive when nothing is translated", async () => {
    const epub = await readEpub(await buildEpub(FIXTURES[0]));
    const before = inspect(epub.entries);
    const written = await writeEpub(epub.entries);
    const after = inspect((await readEpub(written)).entries);
    expect(after.resourcePaths).toEqual(before.resourcePaths);
    expect(after.binaryHashes).toEqual(before.binaryHashes);
    expect(findPackagePath(epub.entries)).toBe(before.opfPath);
  });
});
```

- [ ] **Step 2: Eseguirlo e verificare che fallisca**

Run: `npx vitest run core/test/identity.test.ts`
Atteso: FAIL, `Cannot find module '../epub/index.ts'`.

- [ ] **Step 3: Scrivere la superficie pubblica**

`core/epub/index.ts` riesporta, e nient'altro:

```ts
export { EpubError, EpubReadError, EpubWriteError, ScanError } from "./errors.ts";
export { LIMITS, readEpub, sha256, writeEpub } from "./zip.ts";
export type { EpubArchive, ZipEntry } from "./zip.ts";
export { assertUtf8, assertWellFormed, decodeEntities, escapeAttr, escapeText, scan } from "./scan.ts";
export type { ScanAttr, ScanEvent, ScanKind } from "./scan.ts";
export { BLOCKS, NAV_BLOCKS, NEVER_TRANSLATED, OPAQUE, TRANSLATABLE_ATTRIBUTES, extract, isWork } from "./blocks.ts";
export type { ExtractReport, Placeholder, PlaceholderAttr, TranslationUnit, UnitKind, UnitState } from "./blocks.ts";
export { archiveCodeSurfaces } from "./css.ts";
export { buildSkeleton, fillSkeleton, SkeletonError } from "./skeleton.ts";
export type { FillResult, Skeleton } from "./skeleton.ts";
export { render } from "./splice.ts";
export { findPackagePath, readPackage, writeLanguage, writeRootLang } from "./package.ts";
export type { ManifestItem, PackageDoc, SpineItem } from "./package.ts";
export { hasOverlays, removeOverlays } from "./overlay.ts";
export type { OverlayRemoval } from "./overlay.ts";
export { detectLayout } from "./layout.ts";
export type { Layout, LayoutReport } from "./layout.ts";
export { inspect } from "./inspect.ts";
export type { EpubModel, GuideRef, NavEntry } from "./inspect.ts";
export { checkInvariants } from "./invariants.ts";
export type { CheckInput, InvariantResult } from "./invariants.ts";
export { findJar, introducedMessages, runEpubcheck } from "./epubcheck.ts";
export type { EpubcheckMessage, EpubcheckResult } from "./epubcheck.ts";
```

- [ ] **Step 4: Eseguire l'intera suite**

```bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"
npm test -w core
npm run typecheck -w core
```

Atteso: tutti i test passano, `tsc --noEmit` senza errori.

- [ ] **Step 5: Commit**

```bash
git add core/epub/index.ts core/test/identity.test.ts
git commit -m "feat(epub): public surface, and identity asserted on nine fixtures"
```

---

## Definizione di finito

Il piano 1 è completo quando:

- `npm test -w core` è verde e `npm run typecheck -w core` non ha errori;
- i dodici sabotaggi fanno scattare le invarianti che dichiarano;
- il riempimento nullo restituisce ogni documento byte per byte su tutte e nove le fixture;
- `core/epub/index.ts` è l'unico punto di ingresso, e il test di confine impedisce a `core/` di importare Electron, `node:sqlite` o un pacchetto di provider.

**Non è compreso in questo piano**, e arriva nei successivi: qualunque chiamata a un modello, il glossario, la sessione, il database, l'interfaccia. Il layer di questo piano non sa che esiste un LLM.

## Verifica manuale consigliata a fine piano

Prima di passare al piano 2, provare l'identità su un EPUB vero — per esempio uno dei libri già presenti in `~/Development/OWN/Translator/`. Estrazione più riempimento nullo deve restituire ogni documento identico. Nel prototipo questo esercizio, su tre libri reali, ha trovato due difetti veri che nessuna fixture generata aveva mostrato: le entità HTML (`&copy;`, `&eacute;`) che saxes rifiuta nei file EPUB 2, e il confronto delle lingue come stringhe esatte, che lascia intatto un documento `en` sotto un package `en-us`.

---

## Esito dell'esecuzione (2026-08-25)

Il piano è stato eseguito per intero: 16 commit, 83 test verdi, typecheck pulito. Quanto segue è ciò che il piano diceva e la realtà ha smentito. Vale come storia, non come istruzione: **dove il piano e il codice divergono, vince il codice**.

### Il piano sbagliava

- **`yauzl-promise.open()` pretende un percorso, non un Buffer.** Un archivio in memoria passa da `fromBuffer()`. Il test del Task 2 chiamava `open(bytes)` e lanciava. (`validateFilename` invece era come diceva il piano, non come dice il README del pacchetto.)
- **`yazl` rifiuta un nome di entry che esce dall'archivio**, quindi la fixture `../escape.txt` del Task 3 non è costruibile attraverso di lui. Il generatore scrive un alias della stessa lunghezza in byte e corregge l'archivio finito, asserendo esattamente due sostituzioni: intestazione locale e directory centrale.
- **I due test di `findJar` del Task 16 si contraddicevano**: entrambi nominavano un jar inesistente, uno aspettandosi il percorso e l'altro `null`.
- **Due test leggevano file relativamente alla directory di lavoro**, che cambia tra `npm test` e `npx vitest`. Ora risolvono dal file di test.
- **`byDocument` del Task 12** è indicizzato per percorso nell'archivio, non per href del manifest — come già faceva il test del piano stesso.

### Interfacce che non hanno retto

- `SkeletonError` estende `EpubError` e porta un `code`: altrimenti sarebbe l'unico errore del layer di cui l'interfaccia non può parlare.
- `EpubModel` ha guadagnato `documents` e `identityMetadata`: I12, I17, I18 e I20 devono rileggere i documenti, e `CheckInput` non offriva altra via.
- **I17 confronta il conteggio degli elementi per documento**, non gli intervalli delle unità: gli intervalli sono offset nel documento *prima*, e ogni unità riscritta sposta ciò che segue.
- **I6 è differenziale**: un link già rotto in partenza non si imputa alla traduzione.
- `resolveHref` è entrato nella superficie pubblica (vedi sotto).

### Tre rivendicazioni dei sabotaggi erano irraggiungibili

`renumber-ids`→I6, `drop-attributed-tag`→I5 e `swap-block-range`→I17 non potevano scattare con la fixture del piano. Le rivendicazioni sono state ristrette **e il test rafforzato**: da "almeno una invariante rivendicata fallisce" a **"ognuna deve fallire"**. Una rivendicazione che il corpus non può raggiungere è un desiderio, non un controllo. Il rafforzamento ha scoperto che I18 cercava una sottostringa e quindi non vedeva `<code>ls</code>` diventare `<code>tools</code>`.

### Due bug veri

- **Elementi vuoti**: `saxes` emette `closetag` per `<br/>` alla stessa posizione dell'apertura. Chiudere lo stack lì chiudeva il **genitore**, e ogni fratello dopo un `<br/>` usciva dall'unità. L'ha preso un test del piano.
- **Href percent-encoded**: gli href del manifest sono URL, non nomi di file. "The Dig" scrive `The%20Dig%20-01.htm` per una entry salvata con spazi letterali, e leggere l'href come percorso perdeva **tutti i 24 capitoli, in silenzio**. L'ha trovato la verifica manuale su libri veri che il piano raccomanda in fondo, non una fixture generata. È la ragione per cui quella verifica c'era.

### Verifica su libri reali

Quattro EPUB: **137 documenti, 20.778 unità, ogni documento restituito byte per byte** da un riempimento vuoto. Le invarianti hanno inoltre segnalato due incoerenze vere **dei libri stessi** — un documento di navigazione che dichiara `en` sotto un package `it`, e un package che dichiara `UND` — cioè I19 che fa esattamente il lavoro per cui è stata scritta.

### Un limite noto, non risolto

**Un attributo traducibile sull'elemento di blocco stesso** (`<p title="…">`) non viene tradotto: le unità attributo si estraggono solo dai segnaposto inline, e un attributo del blocco sta fuori dall'intervallo dell'unità. La spec lo vorrebbe tradotto. Va affrontato prima che l'applicazione traduca libri veri.
