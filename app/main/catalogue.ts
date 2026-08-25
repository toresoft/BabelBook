import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Translate = (key: string, params?: unknown) => string;

/**
 * The catalogue, on the main side of the boundary.
 *
 * The tray, its menu and the notifications speak the same language files the
 * window speaks — a second set of sentences here would be a second translation
 * to keep, and the one nobody keeps is the one the user reads.
 *
 * A key that is missing answers with itself: a raw key on a tooltip is a
 * visible defect that gets fixed, an exception that hides the tray is one that
 * hides the application.
 */
export async function loadCatalogue(language: string, dir: string): Promise<Translate> {
  const read = async (name: string): Promise<Record<string, unknown>> => {
    try {
      return JSON.parse(await readFile(join(dir, `${name}.json`), "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  // English is the floor; the chosen language overrides what it defines.
  const catalogue = { ...(await read("en")), ...(await read(language)) };

  const lookup = (key: string): unknown =>
    key.split(".").reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      catalogue,
    );

  return (key, params) => {
    const value = lookup(key);
    if (typeof value !== "string") return key;
    return value.replace(/\{\{(\w+)\}\}/g, (_whole, name: string) =>
      String((params as Record<string, unknown> | undefined)?.[name] ?? ""));
  };
}
