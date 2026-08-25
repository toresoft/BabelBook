import { join } from "node:path";
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, Tray,
} from "electron";
import { loadCatalogue, type Translate } from "./catalogue.ts";
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
import { sdkBackend, type GenerateFn } from "../engine/backends/sdk.ts";
import type { BackendSpec, EngineMessage } from "../shared/run.ts";
import type { VerifyOutcome } from "../shared/dto.ts";
import { notifyOn, onQuitRequested, onWindowClose, trayTooltip } from "./tray.ts";
import { createMainWindow } from "./window.ts";

/** dist/main/main.js sits next to dist/preload and dist/renderer. */
const DIST = join(import.meta.dirname, "..");
const PRELOAD_PATH = join(DIST, "preload", "preload.js");
const RENDERER_ROOT = join(DIST, "renderer");
const LOCALES_DIR = join(DIST, "..", "locales");

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
 * The deterministic backend of the whole-application test.
 *
 * Read here and nowhere else, like every test shortcut. The main decides the
 * run uses it; the engine materialises it, because behaviour cannot cross a
 * process boundary and plain materials can.
 */
const fakeBackend = process.env["BABELBOOK_FAKE_BACKEND"] !== undefined;

/** A 16×16 book-spine square; the tray is a place for a mark, not art. */
const TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVR4nGNgoBawD6z4TwqmSDOGIaMGjBowTAygODNRAgD1q4VQZ5V0WgAAAABJRU5ErkJggg==";

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
      load: (specifier) => import(specifier),
      apiKey: readKey(glue.db, crypto, provider.id),
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      options: provider.options,
    });
    // The specifier rides a variable so TypeScript does not resolve the
    // package: it is the user's to install, and this machine may not have it.
    const aiModule = "ai";
    const ai = await import(aiModule) as { generateText: GenerateFn };
    return await runVerification({ backend: sdkBackend(resolved, ai.generateText), modelId: spec });
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

function openWindow(): void {  const window = createMainWindow({
    preloadPath: PRELOAD_PATH,
    url: devServerUrl ?? `${RENDERER_ORIGIN}/index.html`,
  });

  // Closing the window while a book is in flight hides it; the work goes on.
  window.on("close", (event) => {
    if (glue.quitting) return;
    if (onWindowClose(glue.runtime?.active != null) === "hide") {
      event.preventDefault();
      window.hide();
    }
  });

  glue.window = window;
}

app.whenReady().then(async () => {
  const db = openDatabase(join(userDataDir, "babelbook.db"));
  migrate(db, loadMigrations(join(import.meta.dirname, "migrations")));

  // Nobody spends without being asked: whatever the crash interrupted comes
  // back paused, and nothing resumes on its own at startup.
  restoreRunningProjects(db);

  const settings = readSettings(db);
  const t = await loadCatalogue(settings.uiLanguage, LOCALES_DIR);
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

  registerIpc(ipcMain, {
    db,
    userDataDir,
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
    startRun: (projectId) => runtime.start(projectId),
    pauseRun: (projectId) => runtime.pause(projectId),
    approveGate: (projectId, gate) => runtime.approve(projectId, gate),
    verifyProvider: verify,
    broadcast: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(channel, payload);
      }
    },
  });

  handleRendererProtocol(devServerUrl === undefined ? RENDERER_ROOT : "", join(userDataDir, "projects"));
  glue.tray = buildTray();
  openWindow();

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
