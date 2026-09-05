import { BrowserWindow, nativeImage, nativeTheme } from "electron";
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH } from "../shared/layout.ts";
import { APP_ICON } from "./icons.ts";

export interface MainWindowOptions {
  /** Absolute path of the compiled preload bundle. */
  preloadPath: string;
  /** What the window loads: the app:// bundle, or a dev server. */
  url: string;
}

/**
 * The window's own background, before the renderer has painted anything.
 *
 * It cannot read `--surface` from the stylesheet, so it repeats its value in
 * both themes; the two must be changed together or a dark desktop sees a white
 * flash on every opening.
 */
const SURFACE = nativeTheme.shouldUseDarkColors ? "#0f172a" : "#ffffff";

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
    // Not a taste: under `MIN_WINDOW_WIDTH` the project screen drops the
    // book's column under the list, and the two-column screen the whole
    // layout is built around stops existing. The floor is what makes that
    // width unreachable rather than merely unadvisable.
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    backgroundColor: SURFACE,
    // Wayland takes the window's icon from the desktop entry and ignores this;
    // X11 and Windows use it, and a window with no icon is a grey square in
    // the task switcher.
    icon: nativeImage.createFromDataURL(APP_ICON),
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

/**
 * What is on screen while the window is still empty.
 *
 * The main window is deliberately hidden until Angular has rendered, which is
 * right — an empty frame looks broken. But it left a second or more of nothing
 * at all after the user asked for the application, which looks like nothing
 * happened. This is the answer to that, and it goes away by itself.
 *
 * No preload and no bridge: it shows a mark and a name, and has nothing to ask.
 */
export function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 360,
    height: 220,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    center: true,
    show: false,
    backgroundColor: "#0f172a",
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });

  const page = `<!doctype html><meta charset="utf-8"><style>
    html,body{height:100%;margin:0}
    body{background:#0f172a;color:#e2e8f0;display:grid;place-content:center;justify-items:center;
      gap:.9rem;font:400 14px/1.4 system-ui,sans-serif;-webkit-user-select:none}
    img{width:64px;height:64px;image-rendering:auto}
    b{font-weight:600;font-size:1.05rem;letter-spacing:.01em}
    /* A bar that moves without claiming progress: nothing here knows how far
       along the start is, and a bar that filled up would be inventing it. */
    i{display:block;width:150px;height:3px;border-radius:2px;background:#1e293b;overflow:hidden}
    i::after{content:"";display:block;width:40%;height:100%;border-radius:2px;background:#2563eb;
      animation:slide 1.1s ease-in-out infinite}
    @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
    @media (prefers-reduced-motion:reduce){i::after{animation:none;width:100%}}
  </style><img src="${APP_ICON}" alt=""><b>babelBook</b><i></i>`;

  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  splash.once("ready-to-show", () => splash.show());
  return splash;
}
