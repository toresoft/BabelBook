import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SETTINGS, EVENTS, INVOCATIONS,
  type Events, type Handlers, type Settings, type VerifyOutcome,
} from "../shared/channels.ts";
import { packFailure } from "../shared/dto.ts";
import { createProject } from "./projects/create.ts";
import {
  createProvider, deleteProvider, listProviders, PRESETS, ProviderStoreError, updateProvider,
  type Crypto,
} from "./providers/store.ts";
import { addManualTerm, decideTerms, listTerms, promoteToGlossary } from "./terms/approve.ts";
import { applyInvalidation, previewInvalidation } from "./terms/invalidate.ts";
import { clearForced, forceState, listExclusions } from "./exclusions/review.ts";
import {
  attachToProject, deleteGlossary, detachFromProject, exportGlossary, importGlossary,
  listGlossaries, saveGlossary,
} from "./glossaries/store.ts";
import { buildReport } from "./report/build.ts";
import { listProjects } from "./projects/query.ts";
import { deleteWorkspace, type Workspace } from "./workspace.ts";

export interface IpcDeps {
  db: DatabaseSync;
  userDataDir: string;
  /** The keyring. In production `safeStorage`; in a test, whatever hides bytes. */
  crypto: Crypto;
  /** Opens the native dialog. The main process owns which files exist. */
  chooseEpub(): Promise<{ path: string; name: string } | null>;
  /** Puts a project in the machine's hands, and the machine's verdict on screen. */
  startRun(projectId: string): Promise<void>;
  pauseRun(projectId: string): Promise<void>;
  approveGate(projectId: string, gate: "terms" | "code"): Promise<void>;
  /** One minimal call to the provider, reported as an outcome and never as a sentence. */
  verifyProvider(request: { providerId: string; modelId: string }): Promise<VerifyOutcome>;
  broadcast<K extends keyof Events>(channel: K, payload: Events[K]): void;
}

export function readSettings(db: DatabaseSync): Settings {
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

/**
 * The cache key a project's translations are stored under.
 *
 * The renderer never sends it: it identifies a configuration, not a request,
 * and letting the window name it would let a bug there delete the wrong
 * generation of a book's work.
 */
function cacheKeyOf(db: DatabaseSync, projectId: string): string {
  const row = db.prepare("SELECT cache_key FROM project WHERE id = ?").get(projectId) as
    { cache_key: string | null } | undefined;
  if (row === undefined) throw new Error(`no such project: ${projectId}`);
  return row.cache_key ?? "";
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

    "run.start": async ({ projectId }) => {
      await deps.startRun(projectId);
      deps.broadcast("project.changed", { id: projectId });
    },

    "run.pause": async ({ projectId }) => {
      await deps.pauseRun(projectId);
      deps.broadcast("project.changed", { id: projectId });
    },

    "run.approve": async ({ projectId, gate }) => {
      await deps.approveGate(projectId, gate);
      deps.broadcast("project.changed", { id: projectId });
    },

    "provider.verify": async (request) => deps.verifyProvider(request),

    "terms.list": async ({ projectId }) => listTerms(deps.db, projectId),

    "terms.decide": async ({ projectId, decisions }) =>
      decideTerms(deps.db, projectId, decisions),

    "terms.add": async ({ projectId, ...term }) => addManualTerm(deps.db, projectId, term),

    "terms.promote": async ({ termId, glossaryId }) =>
      promoteToGlossary(deps.db, termId, glossaryId),

    "terms.previewInvalidation": async ({ projectId, termIds }) =>
      previewInvalidation(deps.db, projectId, termIds),

    "terms.invalidate": async ({ projectId, unitIds }) =>
      applyInvalidation(deps.db, projectId, unitIds, cacheKeyOf(deps.db, projectId)),

    "exclusions.list": async ({ projectId }) => listExclusions(deps.db, projectId),

    "exclusions.force": async ({ projectId, changes }) => forceState(deps.db, projectId, changes),

    "exclusions.clear": async ({ projectId, unitIds }) =>
      clearForced(deps.db, projectId, unitIds),

    "glossaries.list": async () => listGlossaries(deps.db),

    "glossary.save": async (glossary) => saveGlossary(deps.db, glossary),

    "glossary.delete": async ({ id }) => deleteGlossary(deps.db, id),

    "glossary.import": async ({ markdown }) => importGlossary(deps.db, markdown),

    "glossary.export": async ({ id }) => ({ markdown: exportGlossary(deps.db, id) }),

    "glossary.attach": async ({ projectId, glossaryId, attached }) => {
      // One channel for both directions: the screen has a checkbox, not two
      // buttons, and splitting it would let the two drift apart.
      if (attached) attachToProject(deps.db, projectId, glossaryId, "user");
      else detachFromProject(deps.db, projectId, glossaryId);
      deps.broadcast("project.changed", { id: projectId });
      return undefined;
    },

    "report.get": async ({ projectId }) => {
      // The latest run, because that is the one the user just watched. Older
      // runs are still in the table and a future screen can offer them.
      const row = deps.db.prepare(
        "SELECT id FROM run WHERE project_id = ? ORDER BY started_at DESC LIMIT 1",
      ).get(projectId) as { id: string } | undefined;
      return row === undefined ? null : buildReport(deps.db, projectId, row.id);
    },

    "providers.list": async () => listProviders(deps.db),

    // Values, not a catalogue: everything a preset carries is editable in the
    // form afterwards, and an id that has moved on is corrected there rather
    // than waiting for a release.
    "providers.presets": async () => PRESETS,

    "provider.create": async (input) => {
      const created = createProvider(deps.db, deps.crypto, input);
      deps.broadcast("providers.changed", {});
      return created;
    },

    "provider.update": async ({ id, ...patch }) => {
      const updated = updateProvider(deps.db, deps.crypto, id, patch);
      deps.broadcast("providers.changed", {});
      return updated;
    },

    "provider.delete": async ({ id }) => {
      // Refusing loudly rather than reporting a silent success: a delete that
      // did nothing means the interface is looking at a list someone else
      // already changed, and hiding that leaves a ghost row on screen.
      if (!deleteProvider(deps.db, id)) {
        throw new ProviderStoreError("PROVIDER_UNKNOWN", `no provider ${id}`);
      }
      deps.broadcast("providers.changed", {});
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
