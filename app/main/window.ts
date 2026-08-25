import { BrowserWindow } from "electron";

export interface MainWindowOptions {
  /** Absolute path of the compiled preload bundle. */
  preloadPath: string;
  /** What the window loads: the app:// bundle, or a dev server. */
  url: string;
}

/**
 * The one window of the application.
 *
 * The renderer gets no Node: it asks the main process instead of reaching for
 * the file system itself, so every path the application touches is one the main
 * process produced.
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    // Showing an empty frame first is worse than showing nothing for a moment.
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  void window.loadURL(options.url);
  return window;
}
