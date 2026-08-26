# babelBook — Piano 6: integrazione continua e pacchetti

**Stato: non iniziato**, al 2026-08-26.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ogni push verifica il progetto su GitHub, e ogni tag produce quattro
pacchetti installabili — AppImage, `.deb`, `.rpm` e un `.exe` per Windows — che
qualcuno ha davvero avviato prima di pubblicarli.

**Architecture:** due workflow. `ci.yml` gira su ogni push e ogni pull request e
non produce niente da scaricare; `release.yml` gira sui tag `v*`, impacchetta su
runner nativi e pubblica una GitHub Release. Il secondo non riesegue i test del
primo: dipende dal suo esito.

**Tech Stack:** GitHub Actions, `electron-builder`, Node 24.18.x, Electron 43.4.1.

**Repository:** `git@github.com:toresoft/BabelBook.git`
**Piani precedenti:** 1–4 completi, 5 a sei task su otto. Questo piano non
dipende dal completamento del 5: verifica e impacchetta ciò che esiste.

---

## Cosa ho verificato prima di scrivere questo piano

Non sono supposizioni: le ho misurate sul repository.

- **Non esiste nessuna CI.** `.github/` non c'è.
- **Non esiste nessuno strumento di packaging.** Né `electron-builder` né
  `electron-forge` sono fra le dipendenze.
- **`package-lock.json` c'è**, quindi `npm ci` è utilizzabile e le installazioni
  sono riproducibili.
- **Non c'è un file che fissi la versione di Node.** La CI deve dichiararla.
- **`vendor/` è in `.gitignore`**, quindi il jar di EPUBCheck non è nel
  repository. I test lo tollerano già: `composeEpub` dichiara `ran: false` e non
  lo spaccia per un successo.
- **Le icone ora ci sono** (`app/build/icon-*.png`, da 16 a 512, generate da
  `app/scripts/make-icons.mjs`). Per Windows resta da produrre un `.ico`
  multi-risoluzione: electron-builder lo deriva dal PNG più grande, ma solo se
  glielo si indica.

### Il vincolo che decide l'architettura

`app/esbuild.mjs` impacchetta main ed engine con `packages: "external"`. Non è
una scelta cosmetica: `yauzl-promise` dipende da **`@node-rs/crc32`**, che
distribuisce **binari precompilati diversi per ogni piattaforma**
(`@node-rs/crc32-linux-x64-gnu`, `@node-rs/crc32-win32-x64-msvc`, …) come
`optionalDependencies`.

Ne discendono due conseguenze che vanno rispettate o il piano non funziona:

1. **`node_modules` deve viaggiare col pacchetto.** L'applicazione non è
   autosufficiente in `dist/`.
2. **Ogni piattaforma va impacchettata sul proprio runner.** `npm ci` su Linux
   installa solo il binario Linux; un `.exe` costruito su Linux verrebbe
   distribuito **senza il binding per Windows** e andrebbe in errore alla prima
   lettura di un EPUB — cioè al primo gesto utile dell'applicazione, e non in
   CI, ma sulla macchina di chi l'ha scaricata.

`@node-rs/crc32` è N-API, quindi è stabile rispetto all'ABI e **non serve**
`electron-rebuild`. È l'unica buona notizia di questa sezione.

### Decisioni che ho preso, e che puoi ribaltare

- **Niente firma del codice.** Un certificato Windows costa e va rinnovato;
  senza, SmartScreen mostra un avviso al primo avvio. Va detto nella release,
  non nascosto. Se un giorno si firma, cambia solo il Task 6.
- **Niente macOS.** Non l'hai chiesto, e aggiungerlo significa un runner in più
  e la notarizzazione Apple.
- **EPUBCheck non viene impacchettato.** Sono circa 30 MB e soprattutto
  richiede una JVM installata: imporre Java a chi vuole tradurre un libro è
  sproporzionato. Resta un percorso configurabile (`epubcheckJar` è già nelle
  impostazioni), e il report dice già "non eseguito" invece di mentire.
- **I pacchetti si producono sui tag, non su ogni push.** Impacchettare quattro
  formati a ogni commit consuma minuti di CI per artefatti che nessuno scarica.

---

## Global Constraints

- **Node 24.18.x** ovunque, dichiarato in un solo posto e letto dai due workflow.
- **`npm ci`, mai `npm install`** in CI: il lockfile è la definizione della build.
- **Nessun test tocca la rete.** Vale in CI come in locale.
- **Un pacchetto non pubblicato prima di essere avviato.** Un artefatto che
  nessuno ha aperto non è un pacchetto, è un file.
- **Nessun segreto nei log.** Nessuno serve oggi, e non va introdotto per caso.
- **Codice e commenti in inglese**, documenti in italiano.
- **Commit a ogni task.**

## Struttura dei file

```
.github/
  workflows/
    ci.yml                  test, typecheck, build su push e pull request
    release.yml             pacchetti e GitHub Release sui tag v*
.nvmrc                      la versione di Node, in un posto solo
app/
  electron-builder.yml      configurazione dei pacchetti
  build/
    icon.png                512×512, per Linux
    icon.ico                multi-risoluzione, per Windows
  scripts/
    smoke-package.mjs       avvia il pacchetto prodotto e verifica che funzioni
```

---

### Task 1: La CI che verifica

**Files:**
- Create: `.github/workflows/ci.yml`, `.nvmrc`

- [ ] **Step 1: Fissare la versione di Node**

`.nvmrc` con `24.18.0`. I workflow usano `node-version-file: .nvmrc`, così la
versione si cambia in un posto solo e non diverge fra i due.

- [ ] **Step 2: Scrivere il workflow**

Un job `verify` su `ubuntu-latest`:

```yaml
name: CI
on:
  push:
    branches: [master]
  pull_request:

# A new push to the same branch makes the previous run pointless: cancel it
# rather than pay for an answer about code that no longer exists.
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build -w app
```

`cache: npm` usa già il lockfile come chiave. Non serve una cache scritta a mano.

- [ ] **Step 3: Verificarlo**

Aprire una pull request di prova e guardarla passare. Poi **rompere di proposito
un test e guardarla fallire**: una CI che non si è mai vista fallire non è una
CI, è un badge.

- [ ] **Step 4: Commit**

---

### Task 2: Le prove end-to-end in CI

**Files:**
- Modify: `.github/workflows/ci.yml`

Le otto prove Playwright aprono una finestra Electron vera. Su un runner Linux
non c'è un display, quindi vanno eseguite sotto `xvfb`.

- [ ] **Step 1: Aggiungere il job**

```yaml
  e2e:
    runs-on: ubuntu-latest
    steps:
      # … checkout, setup-node, npm ci …
      # Electron needs a display even to open a window nobody looks at.
      - run: sudo apt-get update && sudo apt-get install -y xvfb
      - run: xvfb-run --auto-servernum npm run test:e2e -w app
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: app/test-results/
```

Gli artefatti **solo in caso di fallimento**: quando passa non c'è niente da
guardare, e caricarli sempre riempie lo storage di cartelle vuote.

- [ ] **Step 2: Verificare che il job possa fallire**

Rompere un'asserzione end-to-end e controllare che il report caricato dica quale.

- [ ] **Step 3: Commit**

---

### Task 3: electron-builder, e il primo pacchetto locale

**Files:**
- Create: `app/electron-builder.yml`
- Modify: `app/package.json`, `.gitignore`

Prima di toccare la CI, il pacchetto deve nascere **in locale**: fare esordire
electron-builder dentro un workflow significa debuggare a colpi di push.

- [ ] **Step 1: Le icone**

Già fatte: `app/build/` porta da 16 a 512 pixel, generate da
`scripts/make-icons.mjs`. Resta da verificare che electron-builder le prenda
come `buildResources`, e che Windows ottenga il suo `.ico`.

- [ ] **Step 2: La configurazione**

```yaml
appId: dev.toresoft.babelbook
productName: babelBook
directories:
  output: release
  buildResources: build

# The main and engine bundles are built with `packages: "external"`, so the
# production dependencies have to ship. `node_modules` is hoisted to the
# workspace root, which is why the pattern reaches outside `app/`.
files:
  - dist/**
  - package.json
```

Il punto delicato è **la risoluzione delle dipendenze in un monorepo con
workspace**: `npm ci` alla radice issa `saxes`, `xstate`, `yauzl-promise`,
`yazl` e `@node-rs/crc32-*` in `node_modules/` della radice, non in
`app/node_modules/`. electron-builder va configurato perché le trovi. Se la
configurazione dichiarativa non basta, la via pulita è
`buildDependenciesFromSource: false` più un `npm ci --omit=dev` in una
directory di staging.

- [ ] **Step 3: Provare in locale**

`npx electron-builder --dir` produce una cartella non impacchettata. **Avviarla**
e creare un progetto da un EPUB vero: è il gesto che tocca `yauzl-promise` e
quindi `@node-rs/crc32`, cioè esattamente ciò che si rompe quando le dipendenze
non sono state incluse.

- [ ] **Step 4: Commit**

---

### Task 4: I tre pacchetti Linux

**Files:**
- Modify: `app/electron-builder.yml`

- [ ] **Step 1: Dichiarare i target**

```yaml
linux:
  target: [AppImage, deb, rpm]
  category: Office
  synopsis: Traduce libri EPUB con un modello linguistico
```

- [ ] **Step 2: Costruirli e installarli**

Su Fedora: `sudo dnf install ./release/babelBook-0.1.0.x86_64.rpm`, poi aprire
l'applicazione dal menu. L'AppImage va reso eseguibile e avviato. Il `.deb` va
provato su una Debian o Ubuntu — un container basta.

Questo è il task in cui **emergono le dipendenze di sistema mancanti**: le
distribuzioni le dichiarano diversamente, e un `.rpm` che si installa ma non si
avvia è il difetto tipico di questo passaggio.

- [ ] **Step 3: Commit**

---

### Task 5: L'eseguibile per Windows

**Files:**
- Modify: `app/electron-builder.yml`

- [ ] **Step 1: Dichiarare il target**

```yaml
win:
  target: [nsis]
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  perMachine: false
```

`oneClick: false` perché un installer che parte, decide dove installarsi e
finisce senza chiedere niente è la cosa che fa disinstallare un programma.

- [ ] **Step 2: Costruirlo su Windows**

**Non su Linux.** Vale quanto scritto in testa al piano: `npm ci` su Linux non
installa `@node-rs/crc32-win32-x64-msvc`, e l'`.exe` risultante andrebbe in
errore alla prima lettura di un EPUB, sulla macchina dell'utente.

- [ ] **Step 3: Commit**

---

### Task 6: Il workflow di rilascio

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Scrivere la matrice**

```yaml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  package:
    strategy:
      # One runner never builds another platform's package: the native
      # prebuilds of @node-rs/crc32 are per-platform, and a cross-built
      # artifact would fail on the user's machine, not here.
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            targets: --linux AppImage deb rpm
          - os: windows-latest
            targets: --win nsis
    runs-on: ${{ matrix.os }}
    steps:
      # … checkout, setup-node, npm ci, npm run build -w app …
      - run: npx electron-builder ${{ matrix.targets }} --publish never
        working-directory: app
      - uses: actions/upload-artifact@v4
        with:
          name: packages-${{ matrix.os }}
          path: app/release/*.*
```

`fail-fast: false` perché il fallimento su Windows non deve buttare via il
pacchetto Linux già costruito.

- [ ] **Step 2: La release**

Un job `publish` che dipende da `package`, scarica gli artefatti e crea la
GitHub Release. Il corpo deve **dire che i binari non sono firmati**: l'utente
vedrà un avviso di SmartScreen e ha diritto di sapere perché prima di
incontrarlo.

- [ ] **Step 3: Verificarlo su un tag di prova**

`v0.1.0-rc.1`, e poi **scaricare gli artefatti prodotti dalla release e
installarli**. Non guardare la lista dei file: aprirli.

- [ ] **Step 4: Commit**

---

### Task 7: La prova che il pacchetto funziona

**Files:**
- Create: `app/scripts/smoke-package.mjs`
- Modify: `.github/workflows/release.yml`

Questo è il task che rende il piano diverso da uno che produce file.

Un `.exe` costruito senza errori e un `.exe` che si apre sono due fatti diversi,
e la CI finora conoscerebbe solo il primo. Il difetto che questo piano teme di
più — il binding di `@node-rs/crc32` assente per la piattaforma di destinazione
— **passa silenziosamente ogni build** e si manifesta solo quando qualcuno apre
un EPUB.

- [ ] **Step 1: Scrivere lo smoke test**

Avvia il pacchetto **non impacchettato** (`--dir`, che ogni target produce
comunque) con Playwright `_electron`, esattamente come le prove end-to-end
esistenti, ma puntando all'eseguibile prodotto invece che alla directory dei
sorgenti. Riusa `BABELBOOK_USER_DATA` e `BABELBOOK_EPUB_FOR_TEST`, che esistono
già per questo motivo.

Deve verificare tre cose, in quest'ordine:

1. la finestra si apre — il preload ha caricato;
2. un EPUB vero viene ingerito e compare in libreria — `yauzl-promise` e il suo
   binding nativo funzionano nel pacchetto;
3. la libreria mostra i conteggi giusti — il database si è aperto e migrato.

Il secondo punto è quello per cui esiste il test.

- [ ] **Step 2: Farlo girare in entrambi i job della matrice**

Su Linux sotto `xvfb`; su Windows direttamente.

- [ ] **Step 3: Verificare che possa fallire**

Rimuovere `@node-rs/crc32` dal pacchetto e controllare che lo smoke test cada.
Se passa lo stesso, non sta verificando ciò che dice.

- [ ] **Step 4: Commit**

---

### Task 8: Rifiniture

**Files:**
- Modify: entrambi i workflow, `README.md`

- [ ] **Step 1: I permessi**

Ogni workflow dichiara `permissions:` col minimo necessario — `contents: read`
per la CI, `contents: write` solo per il job che pubblica la release. Il default
di GitHub è più largo del necessario.

- [ ] **Step 2: Le azioni bloccate a una versione**

`actions/checkout@v4` va bene; se un giorno servisse un'azione di terze parti,
va bloccata a uno SHA e non a un tag mobile.

- [ ] **Step 3: Il README**

Come si installa ogni formato, e la frase sulla mancanza di firma. Chi scarica
un `.rpm` non deve dedurre da solo il comando.

- [ ] **Step 4: Commit**

---

## Definizione di finito

- Ogni push su `master` e ogni pull request eseguono typecheck, i 538 test, le
  otto prove end-to-end e la build di produzione.
- **La CI è stata vista fallire** per un test rotto di proposito, e il report è
  scaricabile.
- Un tag `v*` produce AppImage, `.deb`, `.rpm` e `.exe`, ciascuno costruito sul
  runner della sua piattaforma.
- **Ogni pacchetto è stato avviato** — dalla CI con lo smoke test, e a mano
  almeno una volta per formato.
- Lo smoke test è stato visto fallire togliendo il binding nativo.
- La release dichiara che i binari non sono firmati.

## Cosa questo piano non dà

- **Nessuna firma, nessuna notarizzazione.** Su Windows resta l'avviso.
- **Niente macOS.**
- **Nessun aggiornamento automatico.** `electron-updater` vuole un canale di
  distribuzione e una firma per avere senso.
- **EPUBCheck non è nel pacchetto**: chi lo vuole indica il jar dalle
  impostazioni. Il report continua a distinguere "non eseguito" da "superato".
- **Nessuna prova con un provider vero**: resta il rischio numero uno del
  progetto, e nessuna CI lo può togliere senza mettere una chiave in un segreto
  e spendere a ogni build.
