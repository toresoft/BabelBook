import type { EngineMessage } from "../shared/run.ts";

/**
 * The lifecycle decisions, as pure functions.
 *
 * They live apart from Electron because a window that hides itself is a
 * promise about the user's work, and a promise is worth testing without
 * starting an application to check it.
 */
export interface Lifecycle {
  onWindowClose(hasRunningWork: boolean): "hide" | "quit";
  onQuitRequested(hasRunningWork: boolean): "confirm" | "quit";
}

/**
 * Closing the window while a book is in flight hides it; the application stays
 * alive in the tray and the work goes on. The user who meant to quit has a
 * menu item for that, one that asks first.
 */
export function onWindowClose(hasRunningWork: boolean): "hide" | "quit" {
  return hasRunningWork ? "hide" : "quit";
}

/** Quitting with work in flight is a decision, so it is asked for, not assumed. */
export function onQuitRequested(hasRunningWork: boolean): "confirm" | "quit" {
  return hasRunningWork ? "confirm" : "quit";
}

/**
 * What the tray says about the book under translation.
 *
 * The sentence comes from the catalogue: a tooltip written here would be one
 * more language the interface speaks, and the only one it speaks just once.
 */
export function trayTooltip(
  state: { title: string; done: number; total: number },
  t: (key: string, params?: unknown) => string,
): string {
  return t("tray.translating", state);
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
