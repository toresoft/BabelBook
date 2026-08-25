import { join } from "node:path";
import { app, BrowserWindow } from "electron";
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

registerRendererScheme();

function openWindow(): void {
  createMainWindow({
    preloadPath: PRELOAD_PATH,
    url: devServerUrl ?? `${RENDERER_ORIGIN}/index.html`,
  });
}

app.whenReady().then(() => {
  if (devServerUrl === undefined) handleRendererProtocol(RENDERER_ROOT);
  openWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
