# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: shots.spec.ts >> cattura
- Location: app/e2e/shots.spec.ts:10:1

# Error details

```
TimeoutError: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for getByTestId('settings')

```

# Test source

```ts
  1  | import { mkdtemp, writeFile } from "node:fs/promises";
  2  | import { tmpdir } from "node:os";
  3  | import { join } from "node:path";
  4  | import { _electron as electron, test } from "@playwright/test";
  5  | import { buildEpub } from "../../core/test/corpus/build.ts";
  6  | import { mainWindow } from "./support.ts";
  7  | 
  8  | const OUT = "/tmp/claude-1000/-home-salvatore-Development-OWN-babelBook/08e3cca8-dc19-4b57-bfdb-d2d850c5df18/scratchpad/shots";
  9  | 
  10 | test("cattura", async () => {
  11 |   const dir = await mkdtemp(join(tmpdir(), "babelbook-shots-"));
  12 |   const epub = join(dir, "book.epub");
  13 |   await writeFile(epub, await buildEpub({
  14 |     title: "Il nome della rosa", language: "en",
  15 |     documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>Rivendell was quiet</p><p>Rivendell again</p><pre>npm install foo</pre>" }],
  16 |   }));
  17 | 
  18 |   const app = await electron.launch({
  19 |     args: ["."], cwd: join(import.meta.dirname, ".."),
  20 |     env: { ...process.env, BABELBOOK_USER_DATA: dir, BABELBOOK_FAKE_BACKEND: "1", BABELBOOK_EPUB_FOR_TEST: epub },
  21 |   });
  22 |   const w = await mainWindow(app);
  23 |   await w.setViewportSize({ width: 1280, height: 860 });
  24 | 
  25 |   await w.screenshot({ path: `${OUT}/01-libreria-vuota.png` });
  26 |   await w.getByTestId("new-project").click();
  27 |   await w.screenshot({ path: `${OUT}/02-nuovo-progetto.png` });
  28 |   await w.getByTestId("choose-epub").click();
  29 |   await w.getByTestId("target-language").selectOption("it");
  30 |   await w.waitForTimeout(400);
  31 |   await w.screenshot({ path: `${OUT}/03-nuovo-analizzato.png` });
  32 |   await w.getByTestId("create").click();
  33 |   await w.screenshot({ path: `${OUT}/04-libreria.png` });
  34 | 
  35 |   await w.locator("a.tile__title").first().click();
  36 |   await w.screenshot({ path: `${OUT}/05-progetto-panoramica.png` });
  37 |   await w.getByTestId("tab-units").click();
  38 |   await w.waitForTimeout(300);
  39 |   await w.screenshot({ path: `${OUT}/06-unita.png` });
  40 |   await w.getByTestId("tab-report").click();
  41 |   await w.waitForTimeout(300);
  42 |   await w.screenshot({ path: `${OUT}/07-report.png` });
  43 | 
> 44 |   await w.getByTestId("settings").click();
     |                                   ^ TimeoutError: locator.click: Timeout 30000ms exceeded.
  45 |   await w.waitForTimeout(300);
  46 |   await w.screenshot({ path: `${OUT}/08-impostazioni-provider.png` });
  47 |   await w.getByTestId("catalog-query").fill("anthropic");
  48 |   await w.waitForTimeout(500);
  49 |   await w.screenshot({ path: `${OUT}/09-ricerca-provider.png` });
  50 |   await app.close();
  51 | });
  52 | 
```