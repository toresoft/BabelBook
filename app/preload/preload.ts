import { contextBridge } from "electron";

/**
 * The only thing the renderer is handed.
 *
 * This bundle is emitted as CommonJS on purpose: with sandbox: true Electron
 * loads a preload script as CommonJS, and an ESM bundle here fails silently
 * with the window already open.
 *
 * The typed channel surface arrives with the IPC task; for now the bridge only
 * proves it loaded, so that a missing preload is visible instead of guessed at.
 */
contextBridge.exposeInMainWorld("babelbook", {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
