import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { loadMigrations, migrate, openDatabase } from "./db/open.ts";
import { registerIpc } from "./ipc.ts";
import {
  handleRendererProtocol,
  registerRendererScheme,
  RENDERER_ORIGIN,
} from "./protocol.ts";
import { createMainWindow } from "./window.ts";

/** dist/main/main.js sits next to dist/preload and dist/renderer. */
const DIST = join(import.meta.dirname, "..");
const PRELOAD_PATH = join(DIST, "preload", "preload.js");
const RENDERER_ROOT = join(DIST, "renderer");

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

registerRendererScheme();

function openWindow(): void {
  createMainWindow({
    preloadPath: PRELOAD_PATH,
    url: devServerUrl ?? `${RENDERER_ORIGIN}/index.html`,
  });
}

app.whenReady().then(() => {
  const db = openDatabase(join(userDataDir, "babelbook.db"));
  migrate(db, loadMigrations(join(import.meta.dirname, "migrations")));

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
    broadcast: (channel, payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(channel, payload);
      }
    },
  });

  handleRendererProtocol(devServerUrl === undefined ? RENDERER_ROOT : "", join(userDataDir, "projects"));
  openWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
