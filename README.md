# babelBook

Traduce libri EPUB con un modello linguistico, conservando la struttura del
libro byte per byte e chiedendo prima di spendere.

Un progetto è un libro. babelBook ne copia l'EPUB in uno spazio di lavoro, lo
analizza, propone i termini da fissare, mostra cosa non verrà tradotto, traduce
e ricompone — fermandosi a due punti in cui la decisione è tua.

## Installazione

I pacchetti si trovano nella pagina delle
[release](https://github.com/toresoft/BabelBook/releases).

| Formato | Per | Come |
|---|---|---|
| `.AppImage` | qualunque distribuzione | `chmod +x babelBook-*.AppImage` e avvialo |
| `.deb` | Debian, Ubuntu e derivate | `sudo apt install ./babelBook-*.deb` |
| `.rpm` | Fedora e derivate | `sudo dnf install ./babelBook-*.rpm` |
| `.exe` | Windows | eseguilo: l'installer chiede dove installare |

**I binari non sono firmati.** Al primo avvio Windows mostra un avviso di
SmartScreen. È la conseguenza di non avere un certificato di firma, non di un
problema del programma.

**EPUBCheck non è incluso**: richiederebbe una JVM installata. Se lo vuoi,
indica il percorso del suo jar in *Impostazioni → Applicazione*. Senza, il
report dichiara che il controllo non è stato eseguito, invece di darlo per
superato.

## Cosa serve per usarlo

Un provider di modelli con una chiave API. Si aggiunge da *Impostazioni →
Provider*, partendo da un preset o da zero. **La chiave viene cifrata con il
portachiavi del sistema operativo e non arriva mai alla finestra**: l'interfaccia
sa soltanto se c'è o se manca.

## Sviluppo

```bash
npm ci                 # scarica anche il binario di Electron
npm run typecheck
npm test               # core, processo main, e componenti Angular
npm run test:e2e -w app   # apre finestre Electron vere
npm start -w app       # costruisce e avvia
```

Node 24.18.x, dichiarato in `.nvmrc`. Il progetto è un workspace npm con due
pacchetti: `core/`, che non conosce né Electron né SQLite, e `app/`, che è
l'applicazione.

### Pacchetti in locale

```bash
npm run build -w app
cd app && npx electron-builder --linux AppImage deb rpm
```

Su Fedora `.deb` e `.rpm` richiedono `libxcrypt-compat`: lo strumento che li
costruisce porta il proprio Ruby, che cerca `libcrypt.so.1`.

Per verificare che un pacchetto si apra davvero:

```bash
BABELBOOK_PACKAGED=app/release/linux-unpacked/babelbook \
  npx playwright test e2e/packaged.spec.ts --config app/playwright.config.ts
```

### Documenti

I piani di implementazione e lo stato del lavoro stanno in
`docs/superpowers/`. `STATO.md` è il punto da cui riprendere.
