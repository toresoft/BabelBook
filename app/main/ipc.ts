import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SETTINGS, EVENTS, INVOCATIONS,
  type Events, type Handlers, type Settings,
} from "../shared/channels.ts";
import { packFailure } from "../shared/dto.ts";
import { createProject } from "./projects/create.ts";
import { listProjects } from "./projects/query.ts";
import { deleteWorkspace, type Workspace } from "./workspace.ts";

export interface IpcDeps {
  db: DatabaseSync;
  userDataDir: string;
  /** Opens the native dialog. The main process owns which files exist. */
  chooseEpub(): Promise<{ path: string; name: string } | null>;
  broadcast<K extends keyof Events>(channel: K, payload: Events[K]): void;
}

function readSettings(db: DatabaseSync): Settings {
  const rows = db.prepare("SELECT key, value FROM setting").all() as Array<{ key: string; value: string }>;
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  return {
    uiLanguage: stored.get("uiLanguage") ?? DEFAULT_SETTINGS.uiLanguage,
    autoAcceptTerms: (stored.get("autoAcceptTerms") ?? "") === "true",
    autoAcceptExclusions: (stored.get("autoAcceptExclusions") ?? "") === "true",
    concurrency: Number(stored.get("concurrency") ?? DEFAULT_SETTINGS.concurrency),
    epubcheckJar: stored.get("epubcheckJar") ?? null,
  };
}

function workspaceOf(db: DatabaseSync, id: string): Workspace {
  const row = db.prepare("SELECT workspace_path FROM project WHERE id = ?").get(id) as
    { workspace_path: string } | undefined;
  if (row === undefined) throw new Error(`no such project: ${id}`);

  const root = row.workspace_path;
  return {
    root,
    source: `${root}/source.epub`,
    outputDir: `${root}/output`,
    exportDir: `${root}/export`,
  };
}

/**
 * The handlers, as data.
 *
 * Returning the map instead of registering it straight onto `ipcMain` is what
 * makes this testable without Electron — and a test can then assert that the
 * map's keys are exactly the declared channels, which a file full of
 * `ipcMain.handle(...)` calls cannot promise.
 */
export function buildHandlers(deps: IpcDeps): Handlers {
  return {
    "projects.list": async ({ filter }) => listProjects(deps.db, filter),

    "project.chooseEpub": async () => deps.chooseEpub(),

    "project.create": async (request) => {
      const created = await createProject(deps.db, deps.userDataDir, request);
      deps.broadcast("project.changed", { id: created.id });
      return created;
    },

    "project.update": async ({ id, targetLanguage, sourceLanguage, description }) => {
      // The language decides the cache key, so it is not a label: changing it
      // makes every stored translation belong to another contract. Confirming
      // it before any run starts is the cheap moment to get it right.
      const changed = deps.db.prepare(`
        UPDATE project
           SET target_language = coalesce(?, target_language),
               source_language = coalesce(?, source_language),
               description     = coalesce(?, description),
               state = CASE
                 WHEN state = 'needs-language' AND coalesce(?, source_language) IS NOT NULL
                   THEN 'ready' ELSE state END
         WHERE id = ?
      `).run(targetLanguage ?? null, sourceLanguage ?? null, description ?? null,
        sourceLanguage ?? null, id);

      if (changed.changes === 0) throw new Error(`no such project: ${id}`);
      deps.broadcast("project.changed", { id });
    },

    "project.delete": async ({ id, keepOutput }) => {
      const workspace = workspaceOf(deps.db, id);
      await deleteWorkspace(workspace, keepOutput === undefined ? {} : { keepOutput });
      // The cascades take the documents, units, translations and events with
      // it: the schema owns that, not this handler.
      deps.db.prepare("DELETE FROM project WHERE id = ?").run(id);
      deps.broadcast("project.changed", { id });
    },

    "settings.get": async () => readSettings(deps.db),

    "settings.set": async (patch) => {
      if (patch.concurrency !== undefined
        && (!Number.isInteger(patch.concurrency) || patch.concurrency < 1)) {
        throw new Error(`concurrency must be a positive integer, got ${patch.concurrency}`);
      }

      const statement = deps.db.prepare(`
        INSERT INTO setting (key, value) VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        statement.run(key, String(value));
      }
      return readSettings(deps.db);
    },
  };
}

/** Minimal Electron surface, so this module needs no Electron to be tested. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, request: unknown) => unknown): void;
}

export function registerIpc(ipcMain: IpcMainLike, deps: IpcDeps): void {
  const handlers = buildHandlers(deps);
  for (const channel of INVOCATIONS) {
    ipcMain.handle(channel, async (_event, request) => {
      try {
        return await (handlers[channel] as (request: unknown) => unknown)(request);
      } catch (error) {
        // Repacked, not rethrown: the class and its fields do not cross, and
        // a code the window cannot read is a code that does not exist.
        throw new Error(packFailure(error));
      }
    });
  }
}

export { EVENTS, INVOCATIONS };
