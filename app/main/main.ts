import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText } from "ai";
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage,
  shell, Tray, type MessageBoxOptions,
} from "electron";
import { loadCatalogue, type Translate } from "./catalogue.ts";
import {
  CatalogError, installCatalog, parseImportedCatalog, readCatalog, refreshCatalog,
  type CatalogPaths,
} from "./catalog/load.ts";
import { catalogState, discoverFromUrl, modelsForEntry, searchCatalog } from "./catalog/service.ts";
import { probeLocalRuntimes } from "./catalog/local.ts";
import { refreshCatalogMetadata } from "./providers/store.ts";
import { loadMigrations, migrate, openDatabase } from "./db/open.ts";
import { registerIpc, readSettings } from "./ipc.ts";
import { restoreRunningProjects } from "./run/machine-host.ts";
import { makeRunRuntime, type RunRuntime } from "./run/runtime.ts";
import {
  handleRendererProtocol,
  registerRendererScheme,
  RENDERER_ORIGIN,
} from "./protocol.ts";
import { getProvider, readKey, type Crypto } from "./providers/store.ts";
import { classifyError, verifyProvider as runVerification } from "./providers/verify.ts";
import { resolveModel } from "../engine/backends/resolve.ts";
import { sdkBackend } from "../engine/backends/sdk.ts";
import type { BackendSpec, EngineMessage } from "../shared/run.ts";
import type { Events } from "../shared/channels.ts";
import type { VerifyOutcome } from "../shared/dto.ts";
import { notifyOn, onQuitRequested, onWindowClose, trayTooltip } from "./tray.ts";
import { TRAY_ICON } from "./icons.ts";
import { createMainWindow, createSplashWindow } from "./window.ts";

/** dist/main/main.js sits next to dist/preload and dist/renderer. */
const DIST = join(import.meta.dirname, "..");
const PRELOAD_PATH = join(DIST, "preload", "preload.js");
const RENDERER_ROOT = join(DIST, "renderer");
const LOCALES_DIR = join(DIST, "..", "locales");

/** The bundled snapshot, and where updates land in the user's data. */
const catalogPaths = (dataDir: string): CatalogPaths => ({
  bundled: join(DIST, "catalog", "snapshot.json.gz"),
  cache: join(dataDir, "catalog.json.gz"),
});

/** Set by `ng serve`, so that a rebuild reaches the window without a restart. */
const devServerUrl = process.env["NG_DEV_SERVER"] ?? process.env["VITE_DEV_SERVER"];

/**
 * Where the database and the workspaces live.
 *
 * The override exists for the end-to-end tests, which must not touch the real
 * library. It is read here and nowhere else: a test shortcut scattered through
 * the code becomes a production path by accident.
 */
const userDataDir = process.env["BABELBOOK_USER_DATA"] ?? app.getPath("userData");

/**
 * The end-to-end catalogue: a file the test writes, served instead of the
 * bundled snapshot so the window can be driven against providers that do not
 * exist. With it set, the background refresh is off — the network would
 * otherwise replace the test's own catalogue mid-run.
 */
const catalogForTest = process.env["BABELBOOK_CATALOG_FOR_TEST"];

/** The end-to-end local runtimes: "ollama=port;lmstudio=port", read the same way. */
function localPortsForTest(): { ollama?: number; lmstudio?: number } {
  const raw = process.env["BABELBOOK_LOCAL_PORTS_FOR_TEST"];
  if (raw === undefined) return {};
  const ports: { ollama?: number; lmstudio?: number } = {};
  for (const pair of raw.split(";")) {
    const [id, port] = pair.split("=");
    if (id === "ollama" || id === "lmstudio") ports[id] = Number(port);
  }
  return ports;
}

/**
 * The deterministic backend of the whole-application test.
 *
 * Read here and nowhere else, like every test shortcut. The main decides the
 * run uses it; the engine materialises it, because behaviour cannot cross a
 * process boundary and plain materials can.
 */
const fakeBackend = process.env["BABELBOOK_FAKE_BACKEND"] !== undefined;


registerRendererScheme();

const crypto: Crypto = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain: string) => safeStorage.encryptString(plain),
  decrypt: (blob: Buffer) => safeStorage.decryptString(blob),
};

/** The main-side proof that a provider works, in the vocabulary of codes. */
async function verify(request: { providerId: string; modelId: string }): Promise<VerifyOutcome> {
  const provider = getProvider(glue.db, request.providerId);
  if (provider === null) return { ok: false, code: "bad-spec" };

  const spec = `${provider.route}:${request.modelId}`;
  try {
    const resolved = await resolveModel(spec, {
      apiKey: readKey(glue.db, crypto, provider.id),
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      options: provider.options,
    });
    return await runVerification({ backend: sdkBackend(resolved, generateText), modelId: spec });
  } catch (error) {
    return { ok: false, code: classifyError(error) };
  }
}

interface Glue {
  db: import("node:sqlite").DatabaseSync;
  t: Translate;
  runtime: RunRuntime;
  tray: Tray | null;
  window: BrowserWindow | null;
  quitting: boolean;
}

/** The parts the lifecycle needs, held together where Electron can see them. */
const glue = { tray: null, window: null, quitting: false } as unknown as Glue;

function titleOf(projectId: string): string {
  const row = glue.db.prepare("SELECT title FROM project WHERE id = ?").get(projectId) as
    { title: string } | undefined;
  return row?.title ?? projectId;
}

function notify(key: string, params?: unknown): void {
  // A desktop that refuses notifications must not take the run down with it.
  try {
    new Notification({ title: "babelBook", body: glue.t(key, params) }).show();
  } catch {
    /* the tray and the library still say what happened */
  }
}

function updateTooltip(message: EngineMessage): void {
  if (glue.tray === null) return;
  if (message.type === "done") {
    glue.tray.setToolTip(glue.t("tray.idle"));
    return;
  }
  if (message.type !== "progress" || glue.runtime === undefined) return;
  const projectId = glue.runtime.active;
  if (projectId === null) return;
  glue.tray.setToolTip(trayTooltip(
    { title: titleOf(projectId), done: message.done, total: message.total },
    glue.t,
  ));
}

function buildTray(): Tray | null {
  // GNOME without an extension has no tray; the application owes it a life
  // anyway, because the work keeps running in the engine process.
  try {
    const tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON));
    tray.setToolTip(glue.t("tray.idle"));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: glue.t("tray.open"), click: () => glue.window?.show() },
      { label: glue.t("tray.pause"), enabled: false, id: "pause" },
      { type: "separator" },
      { label: glue.t("tray.quit"), click: () => void askQuit() },
    ]));
    tray.on("double-click", () => glue.window?.show());
    return tray;
  } catch {
    return null;
  }
}

/** Quitting is a command, and with work in flight it is a question first. */
async function askQuit(): Promise<void> {
  const decision = onQuitRequested(glue.runtime?.active != null);
  if (decision === "confirm") {
    const chosen = await dialog.showMessageBox({
      type: "question",
      buttons: [glue.t("quit.pauseAndQuit"), glue.t("quit.cancel")],
      defaultId: 0,
      cancelId: 1,
      message: glue.t("quit.confirm"),
    });
    if (chosen.response !== 0) return;
  }

  // A clean pause: the signal aborts, the engine closes, then the app ends.
  glue.quitting = true;
  await glue.runtime?.shutdown();
  app.quit();
}

function openWindow(): void {
  const window = createMainWindow({
    preloadPath: PRELOAD_PATH,
    url: devServerUrl ?? `${RENDERER_ORIGIN}/index.html`,
  });

  // Closing the window while a book is in flight hides it; the work goes on.
  window.on("close", (event) => {
    if (glue.quitting) return;
    if (onWindowClose(glue.runtime?.active != null, glue.tray !== null) === "hide") {
      event.preventDefault();
      window.hide();
    }
  });

  glue.window = window;
}

app.whenReady().then(async () => {
  // Raised before the database, the catalogues and the window: everything
  // below takes time, and until now the user had been looking at nothing.
  const splash = createSplashWindow();
  const closeSplash = (): void => {
    if (!splash.isDestroyed()) splash.destroy();
  };

  const db = openDatabase(join(userDataDir, "babelbook.db"));
  migrate(db, loadMigrations(join(import.meta.dirname, "migrations")));

  // Nobody spends without being asked: whatever the crash interrupted comes
  // back paused, and nothing resumes on its own at startup.
  restoreRunningProjects(db);

  const settings = readSettings(db);
  const t = await loadCatalogue(settings.uiLanguage, LOCALES_DIR);

  // The provider catalogue is disk work only: the bundled snapshot, or the
  // cache when it is newer. The network is never on this path — it is asked
  // in the background, when there is a spare moment and a network to ask.
  const paths = catalogPaths(userDataDir);
  let loaded = catalogForTest === undefined
    ? await readCatalog(paths)
    : {
      catalog: parseImportedCatalog(await readFile(catalogForTest)),
      bundled: true, stale: false, changed: false, checkedAt: null,
    };

  glue.db = db;
  glue.t = t;

  const runtime = makeRunRuntime({
    db,
    settings: () => readSettings(db),
    backendSpec(projectId: string): BackendSpec {
      if (fakeBackend) return { kind: "fake" };
      const row = db.prepare(`
        SELECT p.provider_id AS providerId, p.model_id AS modelId,
               pr.route, pr.base_url AS baseUrl, pr.headers, pr.options
          FROM project p LEFT JOIN provider pr ON pr.id = p.provider_id
         WHERE p.id = ?
      `).get(projectId) as {
        providerId: string | null; modelId: string | null; route: string | null;
        baseUrl: string | null; headers: string | null; options: string | null;
      } | undefined;
      if (row === undefined || row.providerId === null || row.modelId === null || row.route === null) {
        throw new Error("NO_PROVIDER_CONFIGURED");
      }
      return {
        kind: "sdk",
        spec: `${row.route}:${row.modelId}`,
        apiKey: readKey(db, crypto, row.providerId),
        baseUrl: row.baseUrl,
        headers: row.headers === null ? {} : JSON.parse(row.headers) as Record<string, string>,
        options: row.options === null ? {} : JSON.parse(row.options) as Record<string, unknown>,
      };
    },
    broadcast: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(channel, payload);
      }
    },
  });
  glue.runtime = runtime;

  runtime.onMessage((message) => {
    updateTooltip(message);
    const notification = notifyOn(message);
    if (notification !== null) {
      notify(notification.key, runtime.active === null ? undefined : { title: titleOf(runtime.active) });
    }
  });

  const broadcast = (channel: keyof Events, payload: Events[keyof Events]) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(channel, payload);
    }
  };

  // The theme is told, not guessed: on Linux the renderer's media query gets
  // stuck on whatever the desktop wore at start-up and never hears a change
  // (electron#22211), so nativeTheme — which does hear it — says so here.
  nativeTheme.on("updated", () => broadcast("theme.changed", { dark: nativeTheme.shouldUseDarkColors }));

  /**
   * What a catalogue change does to what is already stored: the providers
   * bound to an entry take its new prices and dates, their keys and model
   * lists untouched, and every open list hears about it.
   */
  const adoptCatalog = (catalog: import("./catalog/shape.ts").Catalog): void => {
    refreshCatalogMetadata(db, catalog);
    broadcast("providers.changed", {});
  };

  registerIpc(ipcMain, {
    db,
    userDataDir,
    crypto,
    t,
    theme: () => ({ dark: nativeTheme.shouldUseDarkColors }),
    // The question is assembled in the ipc layer; this is only the platform's
    // part of it. The buttons' order is the contract — cancel first — so the
    // defaultId and the cancelId are pinned to it: Return and Escape are the
    // safe answer, never the destructive one.
    askConfirm: async (question) => {
      const options = {
        type: "warning",
        buttons: [question.cancel, question.verify],
        defaultId: 0,
        cancelId: 0,
        message: question.message,
      } satisfies MessageBoxOptions;

      // Parented on the window, so it cannot be lost behind it. An
      // un-parented box is not modal: a click on the main window drops it
      // out of sight, and the renderer goes on awaiting an answer nobody can
      // give any more — a Delete that neither deletes nor fails. With no
      // window there is nothing to hide behind, and nothing to parent on.
      const chosen = glue.window === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(glue.window, options);
      return chosen.response === 1;
    },
    chooseEpub: async () => {
      // The native dialog cannot be driven from a test, so the end-to-end run
      // names the file it would have chosen. Read here and nowhere else: a
      // test shortcut scattered through the code becomes a production path.
      const forTest = process.env["BABELBOOK_EPUB_FOR_TEST"];
      if (forTest !== undefined) return { path: forTest, name: forTest.split("/").pop() ?? forTest };

      const chosen = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "EPUB", extensions: ["epub"] }],
      });
      const path = chosen.filePaths[0];
      return chosen.canceled || path === undefined
        ? null
        : { path, name: path.split("/").pop() ?? path };
    },
    chooseOpen: async (kind) => {
      const chosen = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: kind === "glossary"
          ? [{ name: "Glossary", extensions: ["md", "markdown"] }]
          : kind === "catalog"
            ? [{ name: "Catalogue", extensions: ["json", "gz"] }]
            : [{ name: "JAR", extensions: ["jar"] }],
      });
      return chosen.canceled ? null : chosen.filePaths[0] ?? null;
    },
    chooseSave: async (defaultName, kind) => {
      const chosen = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: kind === "epub"
          ? [{ name: "EPUB", extensions: ["epub"] }]
          : [{ name: "Glossary", extensions: ["md"] }],
      });
      return chosen.canceled || chosen.filePath === undefined ? null : chosen.filePath;
    },
    startRun: (projectId) => runtime.start(projectId),
    pauseRun: (projectId) => runtime.pause(projectId),
    approveGate: (projectId, gate) => runtime.approve(projectId, gate),
    verifyProvider: verify,
    probeLocalRuntimes: () => probeLocalRuntimes({ ports: localPortsForTest() }),
    catalog: {
      search: (query) => searchCatalog(loaded.catalog, query),
      modelsFor: (entryId, apiKey) => modelsForEntry(loaded.catalog, entryId, apiKey),
      discover: (baseUrl, apiKey) => discoverFromUrl(baseUrl, apiKey),
      state: () => catalogState(loaded.catalog, loaded.bundled, loaded.checkedAt),
      refresh: async () => {
        const updated = await refreshCatalog(paths);
        loaded = updated;
        if (updated.changed) adoptCatalog(updated.catalog);
        // The failure is said, not shown: the catalogue that already works
        // keeps answering, and this code is what tells the interface so.
        if (updated.stale) {
          throw new CatalogError("REFRESH_FAILED", "the catalogue could not be updated");
        }
        return catalogState(updated.catalog, updated.bundled, updated.checkedAt);
      },
      importFile: async () => {
        // The file is read by this process, like the glossaries: no path
        // crosses the boundary, and the window learns only the new state.
        const path = await dialog.showOpenDialog({
          properties: ["openFile"],
          filters: [{ name: "Catalogue", extensions: ["json", "gz"] }],
        }).then((chosen) => (chosen.canceled ? null : chosen.filePaths[0] ?? null));
        if (path === null) return catalogState(loaded.catalog, loaded.bundled, loaded.checkedAt);

        const imported = parseImportedCatalog(await readFile(path));
        await installCatalog(paths, imported);
        loaded = { catalog: imported, bundled: false, stale: false, changed: true, checkedAt: null };
        adoptCatalog(imported);
        return catalogState(imported, false);
      },
    },
    openPath: async (path) => {
      await shell.openPath(path);
    },
    revealPath: async (path) => {
      shell.showItemInFolder(path);
    },
    broadcast: (channel, payload) => {
      broadcast(channel, payload);
    },
  });

  handleRendererProtocol(devServerUrl === undefined ? RENDERER_ROOT : "", join(userDataDir, "projects"));
  glue.tray = buildTray();
  openWindow();

  // The network is asked now, in the background and off every critical path:
  // a catalogue that got fresher prices is worth having, and a machine with
  // no network loses nothing by the attempt. Not under a test catalogue,
  // which the network would replace with the real one mid-run.
  if (catalogForTest === undefined) {
    void refreshCatalog(paths).then((updated) => {
      loaded = updated;
      if (updated.changed) adoptCatalog(updated.catalog);
    }).catch(() => {
      /* the catalogue stays as it is; the state line already says its age */
    });
  }

  // Whichever comes first: the window is ready, or it failed and the splash
  // must not be left hanging over an application that is not coming.
  glue.window?.once("ready-to-show", closeSplash);
  glue.window?.webContents.once("did-fail-load", closeSplash);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

app.on("window-all-closed", () => {
  // With work in flight the window is hidden, not closed, so reaching here
  // means the user closed a window nothing depends on.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!glue.quitting) {
    event.preventDefault();
    void askQuit();
  }
});
