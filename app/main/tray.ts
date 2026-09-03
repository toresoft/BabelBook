import type { EngineMessage } from "../shared/run.ts";

/**
 * The lifecycle decisions, as pure functions.
 *
 * They live apart from Electron because a window that hides itself is a
 * promise about the user's work, and a promise is worth testing without
 * starting an application to check it.
 */
export interface Lifecycle {
  onWindowClose(hasRunningWork: boolean, hasTray: boolean): "hide" | "quit";
  onQuitRequested(hasRunningWork: boolean): "confirm" | "quit";
}

/**
 * Closing the window while a book is in flight hides it; the application stays
 * alive in the tray and the work goes on. The user who meant to quit has a
 * menu item for that, one that asks first.
 *
 * Without a tray it must not hide. There would be nothing left to click: the
 * window would be gone, the process alive, and the only way back a kill from a
 * terminal. A desktop that offers no tray is not rare — GNOME without an
 * extension, and any session where the icon fails to register — so this is the
 * ordinary case, not the exotic one.
 */
export function onWindowClose(hasRunningWork: boolean, hasTray: boolean): "hide" | "quit" {
  return hasRunningWork && hasTray ? "hide" : "quit";
}

/**
 * Whether the desktop's watcher lists an item this process owns.
 *
 * `new Tray(...)` returning without throwing proves nothing on Linux.
 * Chromium registers its item by calling `RegisterStatusNotifierItem` with the
 * bus name and the object path joined into one string —
 * `org.freedesktop.StatusNotifierItem-<pid>-1/StatusNotifierItem/1`. KDE's
 * watcher reads that argument as a bus name or as an object path and never as
 * both: it takes the whole thing for a name, finds nobody owning it, and drops
 * the item. The call returns cleanly, the object sits complete on the bus, and
 * no icon is ever drawn.
 *
 * The name carries our process id, which is what makes the answer ours and not
 * a neighbour's. Anything unreadable is a no, deliberately: hiding a window
 * into a tray that turns out not to exist costs the user their book, and
 * refusing to hide into a tray that did exist costs them one dialog.
 */
export function isTrayRegistered(watcherReply: string, pid: number): boolean {
  return new RegExp(`StatusNotifierItem-${pid}-\\d`).test(watcherReply);
}

/** Quitting with work in flight is a decision, so it is asked for, not assumed. */
export function onQuitRequested(hasRunningWork: boolean): "confirm" | "quit" {
  return hasRunningWork ? "confirm" : "quit";
}

/**
 * What the tray says after a message, or null to leave it saying what it says.
 *
 * A tooltip is the only thing a hidden window still tells the user, so it must
 * not go on counting a run that has stopped: a book that failed, or that is
 * waiting at a gate, said "12 of 100" for as long as the application stayed
 * open, and that number was a lie about work in progress.
 *
 * The sentences come from the catalogue: a tooltip written here would be one
 * more language the interface speaks, and the only one it speaks just once.
 */
export function tooltipFor(
  message: EngineMessage,
  title: string | null,
  t: (key: string, params?: unknown) => string,
): string | null {
  if (message.type === "done" || message.type === "failed") return t("tray.idle");
  if (title === null) return null;
  if (message.type === "progress") {
    return t("tray.translating", { title, done: message.done, total: message.total });
  }
  if (message.type === "gate") return t("tray.waiting", { title });
  return null;
}

/**
 * Which engine messages deserve the user's attention, and how to name them.
 *
 * A finished book and a gate left waiting are the two moments a translation
 * stops until someone looks; ordinary progress is not — a notification per
 * chapter is how an application teaches its user to ignore it.
 */
export function notifyOn(message: EngineMessage): { key: string; params?: unknown } | null {
  if (message.type === "done") return { key: "notify.done" };
  if (message.type === "gate") return { key: `notify.gate.${message.gate}` };
  return null;
}
