import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SETTINGS, EVENTS, INVOCATIONS,
  type CatalogEntry, type CatalogState, type ConfirmKind, type Events, type Handlers,
  type LocalRuntime, type ProviderModel, type Settings, type VerifyOutcome,
} from "../shared/channels.ts";
import { packFailure } from "../shared/dto.ts";
import { type Translate } from "./catalogue.ts";
import { createProject } from "./projects/create.ts";
import {
  createProvider, deleteProvider, listProviders, PRESETS, ProviderStoreError, setReasoning,
  updateProvider,
  type Crypto,
} from "./providers/store.ts";
import { addManualTerm, decideTerms, listTerms, promoteToGlossary } from "./terms/approve.ts";
import { applyInvalidation, previewInvalidation } from "./terms/invalidate.ts";
import { clearForced, forceState, listExclusions } from "./exclusions/review.ts";
import {
  attachToProject, deleteGlossary, detachFromProject, exportGlossary, getGlossary,
  importGlossary, listGlossaries, saveGlossary,
} from "./glossaries/store.ts";
import { buildReport } from "./report/build.ts";
import { projectDetail } from "./projects/detail.ts";
import { countProjects, listProjects } from "./projects/query.ts";
import { listUnits } from "./units/list.ts";
import { enterState } from "./run/states.ts";
import { deleteWorkspace, type Workspace } from "./workspace.ts";

export interface IpcDeps {
  db: DatabaseSync;
  userDataDir: string;
  /** The keyring. In production `safeStorage`; in a test, whatever hides bytes. */
  crypto: Crypto;
  /** The main-side catalogue, from which the dialogs take their words. */
  t: Translate;
  /** What the system wears, from nativeTheme: the one truth about the theme. */
  theme(): { dark: boolean };
  /**
   * Asks the window's user through the OS dialog. Injected like every dialog:
   * the question is assembled here, the pixels belong to the platform.
   */
  askConfirm(question: ConfirmQuestion): Promise<boolean>;
  /** Opens the native dialog. The main process owns which files exist. */
  chooseEpub(): Promise<{ path: string; name: string } | null>;
  /**
   * Asks for a file of a named kind, and answers with its path.
   *
   * The kind, not a filter: the window says what it wants, and the main
   * process — which owns the dialog — decides what that means.
   */
  chooseOpen(kind: "glossary" | "jar" | "catalog"): Promise<string | null>;
  chooseSave(defaultName: string, kind: "glossary" | "epub"): Promise<string | null>;
  /** Puts a project in the machine's hands, and the machine's verdict on screen. */
  startRun(projectId: string): Promise<void>;
  composeAgain(projectId: string): Promise<void>;
  pauseRun(projectId: string): Promise<void>;
  approveGate(projectId: string, gate: "terms" | "code"): Promise<void>;
  /** One minimal call to the provider, reported as an outcome and never as a sentence. */
  verifyProvider(request: { providerId: string; modelId: string }): Promise<VerifyOutcome>;
  /**
   * Asks the machine which local runtimes answer. Injected like the dialog:
   * the probe is a network act, and the map that holds it must be testable
   * without one.
   */
  probeLocalRuntimes(): Promise<LocalRuntime[]>;
  /** The provider catalogue, as the window may ask it. Held in the main. */
  catalog: {
    search(query: string): CatalogEntry[];
    modelsFor(entryId: string, apiKey: string | null): Promise<ProviderModel[]>;
    discover(baseUrl: string, apiKey: string | null): Promise<ProviderModel[]>;
    /**
     * The variables the entry's documentation names for its key, or null when
     * no such entry. The boundary's arbiter: a window may name one of these
     * and nothing else, and this is where the main side checks it.
     */
    declaredEnv(entryId: string): string[] | null;
    state(): CatalogState;
    refresh(): Promise<CatalogState>;
    importFile(): Promise<CatalogState>;
  };
  /** Hands a path to the desktop: opens the file, or shows it in its folder. */
  openPath(path: string): Promise<void>;
  revealPath(path: string): Promise<void>;
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

/**
 * Refuses a path that is not inside a project's workspace.
 *
 * The renderer only ever receives paths this process produced, so a request
 * for anything else is either a defect or an attempt; either way the desktop
 * should not be asked to open it.
 */
function assertProduced(db: DatabaseSync, path: string): void {
  const roots = db.prepare("SELECT workspace_path FROM project").all() as
    Array<{ workspace_path: string }>;
  if (!roots.some((row) => path.startsWith(`${row.workspace_path}/`))) {
    throw new Error(`PATH_NOT_PRODUCED: ${path}`);
  }
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
 * The key a request actually carries: the typed one, or the one the named
 * environment variable holds — but only under a name the catalogue entry
 * declares.
 *
 * `apiKeyFromEnv` is a variable's name, never a value — a name is public
 * documentation, and the reading happens here, on the one side that may. The
 * typed key wins, because a paste is the more deliberate act, and it wins
 * before the name is even looked at: the honest window never sends both.
 *
 * A name no entry declares is refused loudly rather than answered as "no
 * key". The window names a variable only after the entry declared it in the
 * same catalogue it was shown, so anything else is a defect or an attempt to
 * marry an arbitrary environment variable to an endpoint of the requester's
 * choosing — and quietly connecting without the key would tell the user
 * their key was saved when it was not.
 */
function resolveKey(
  apiKey: string | null | undefined,
  apiKeyFromEnv: string | null | undefined,
  declaredEnv: string[] | null,
): string | null {
  if (apiKey !== undefined && apiKey !== null && apiKey !== "") return apiKey;
  if (apiKeyFromEnv === undefined || apiKeyFromEnv === null) return null;
  if (declaredEnv === null || !declaredEnv.includes(apiKeyFromEnv)) {
    throw new Error(`ENV_NOT_DECLARED: ${apiKeyFromEnv}`);
  }

  // An own property, or nothing: `process.env` inherits Object.prototype, so
  // a name like "toString" would otherwise answer with a function where a
  // string is promised — one that can never be a key.
  const fromEnv = Object.hasOwn(process.env, apiKeyFromEnv)
    ? process.env[apiKeyFromEnv]
    : undefined;
  return fromEnv === undefined || fromEnv === "" ? null : fromEnv;
}

/**
 * The question a destructive act is asked before it happens.
 *
 * The cancel comes first, and with it travel the Return and the Escape: the
 * key that is easiest to hit must never be the one that destroys. The way in
 * carries a verb that names the act — an "OK" would make every deletion the
 * same word.
 */
export interface ConfirmQuestion {
  cancel: string;
  verify: string;
  message: string;
}

export function confirmQuestion(
  t: Translate,
  db: DatabaseSync,
  kind: ConfirmKind,
  detail: Record<string, string | number>,
): ConfirmQuestion {
  const base = {
    cancel: t("confirm.cancel"),
    verify: t(
      kind === "abandonProject" ? "confirm.abandon"
      : kind === "deleteProvider" ? "confirm.disconnect"
      : kind === "reasoningChange" ? "confirm.apply"
      : "confirm.delete",
    ),
  };

  if (kind === "deleteGlossary") {
    // Counted before anything is destroyed — afterwards there is nothing left
    // to count — because the number belongs in the question, where it can
    // still change the answer.
    const attached = db.prepare("SELECT count(*) AS n FROM project_glossary WHERE glossary_id = ?")
      .get(String(detail["id"] ?? "")) as { n: number };
    // A glossary used by one project is the commonest thing anyone deletes,
    // and the plural sentence writes "1 progetti" for it.
    const key = attached.n === 0 ? "messageNone" : attached.n === 1 ? "messageOne" : "message";
    return {
      ...base,
      message: t(`confirm.deleteGlossary.${key}`, { name: detail["name"] ?? "", count: attached.n }),
    };
  }

  return { ...base, message: t(`confirm.${kind}.message`, detail) };
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
    "ui.confirm": async ({ kind, detail }) => ({
      confirmed: await deps.askConfirm(confirmQuestion(deps.t, deps.db, kind, detail ?? {})),
    }),

    "ui.theme": async () => deps.theme(),

    "ui.chooseSave": async ({ defaultName, kind }) => deps.chooseSave(defaultName, kind),

    "env.hasKey": async ({ name }) =>
      // An own property, or the answer is false: `process.env` inherits
      // Object.prototype, so a name like "toString" would otherwise make the
      // boolean lie about a function nobody ever exported.
      Object.hasOwn(process.env, name) && (process.env[name] ?? "") !== "",

    "projects.list": async ({ filter, bucket }) =>
      listProjects(deps.db, { ...(filter === undefined ? {} : { search: filter }), ...(bucket === undefined ? {} : { bucket }) }),

    "projects.counts": async () => countProjects(deps.db),

    "project.chooseEpub": async () => deps.chooseEpub(),

    "project.create": async (request) => {
      const created = await createProject(deps.db, deps.userDataDir, request);
      deps.broadcast("project.changed", { id: created.id });
      return created;
    },

    "project.update": async ({ id, targetLanguage, sourceLanguage, description, providerId, modelId }) => {
      // The language decides the cache key, so it is not a label: changing it
      // makes every stored translation belong to another contract. Confirming
      // it before any run starts is the cheap moment to get it right.
      const before = deps.db.prepare("SELECT state FROM project WHERE id = ?").get(id) as
        { state: string } | undefined;
      if (before === undefined) throw new Error(`no such project: ${id}`);

      deps.db.exec("SAVEPOINT babelbook_project_update");
      try {
        deps.db.prepare(`
          UPDATE project
             SET target_language = coalesce(?, target_language),
                 source_language = coalesce(?, source_language),
                 description     = coalesce(?, description),
                 provider_id     = coalesce(?, provider_id),
                 model_id        = coalesce(?, model_id),
                 state = CASE
                   WHEN state = 'needs-language' AND coalesce(?, source_language) IS NOT NULL
                     THEN 'ready' ELSE state END
           WHERE id = ?
        `).run(targetLanguage ?? null, sourceLanguage ?? null, description ?? null,
          providerId ?? null, modelId ?? null, sourceLanguage ?? null, id);

        const after = deps.db.prepare("SELECT state FROM project WHERE id = ?").get(id) as { state: string };
        if (after.state !== before.state) {
          enterState(deps.db, { projectId: id, kind: "project", name: after.state });
        }
        deps.db.exec("RELEASE SAVEPOINT babelbook_project_update");
      } catch (error) {
        deps.db.exec("ROLLBACK TO SAVEPOINT babelbook_project_update");
        deps.db.exec("RELEASE SAVEPOINT babelbook_project_update");
        throw error;
      }
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

    "project.export": async ({ id, to, from }) => {
      // The same copy `deleteWorkspace` would make on its way out, offered at
      // the moment someone actually wants it rather than as a side effect of
      // destroying the project around it.
      const workspace = workspaceOf(deps.db, id);
      const produced = await readdir(workspace.outputDir);
      if (produced[0] === undefined) throw new Error("NOTHING_TO_EXPORT");

      // A retranslation under a new language leaves the old EPUB beside the
      // new one, and lexicographic order cannot tell them apart — the window
      // names the file it showed. A name that reaches for another directory
      // is refused outright: falling back here would copy a book the user is
      // not looking at, which is the very defect `from` exists to close.
      if (from !== undefined && (from.includes("/") || from.includes("\\") || from.includes(".."))) {
        throw new Error(`BAD_EXPORT_FROM: ${from}`);
      }
      // `from` is only honoured when the directory actually holds it: an old
      // request naming a file a later run replaced still deserves a copy.
      const name = from !== undefined && produced.includes(from) ? from : produced[0];
      await copyFile(join(workspace.outputDir, name), to);
    },

    "run.start": async ({ projectId }) => {
      await deps.startRun(projectId);
      deps.broadcast("project.changed", { id: projectId });
    },

    "run.compose": async ({ projectId }) => {
      await deps.composeAgain(projectId);
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

    // A closed port is an absent runtime, not an error: the answer is simply
    // the list of whatever answered, possibly nothing.
    "local.runtimes": async () => deps.probeLocalRuntimes(),

    "catalog.search": async ({ query }) => deps.catalog.search(query),

    "catalog.models": async ({ entryId, apiKey, apiKeyFromEnv }) =>
      deps.catalog.modelsFor(
        entryId,
        resolveKey(apiKey, apiKeyFromEnv, deps.catalog.declaredEnv(entryId)),
      ),

    "provider.discover": async ({ baseUrl, apiKey, apiKeyFromEnv }) => {
      // The honest window never names a variable here: a hand-typed endpoint
      // has no documentation to declare one, so there is no list to validate
      // the name against — and reading an arbitrary variable into a request
      // this same call carries to an arbitrary URL would be an exfiltration
      // channel, not a convenience. Rejected, not quietly ignored.
      if (apiKeyFromEnv !== undefined && apiKeyFromEnv !== null) {
        throw new Error(`ENV_NOT_DECLARED: ${apiKeyFromEnv}`);
      }
      return deps.catalog.discover(baseUrl, apiKey ?? null);
    },

    "catalog.state": async () => deps.catalog.state(),

    "catalog.refresh": async () => deps.catalog.refresh(),

    "catalog.importFile": async () => deps.catalog.importFile(),

    "project.get": async ({ id }) => projectDetail(deps.db, id),

    "units.list": async ({ projectId, ...query }) => listUnits(deps.db, projectId, query),

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

    // The renderer never touches the filesystem: it asks, and this process
    // answers with what it parsed. A path would be of no use to a sandboxed
    // window anyway, and handing one over would only invite it to try.
    "glossary.importFile": async () => {
      const path = await deps.chooseOpen("glossary");
      if (path === null) return null;

      const imported = importGlossary(deps.db, await readFile(path, "utf8"));
      deps.broadcast("providers.changed", {});
      return imported;
    },

    "glossary.exportFile": async ({ id }) => {
      // Serialised before the dialog opens: a glossary that cannot be written
      // must not first ask the user where to put it.
      const markdown = exportGlossary(deps.db, id);
      const path = await deps.chooseSave(`${getGlossary(deps.db, id)?.name ?? "glossary"}.md`, "glossary");
      if (path === null) return null;

      await writeFile(path, markdown, "utf8");
      return { path };
    },

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

    // Only a path this process produced. A window free to name any path would
    // be one defect away from asking the desktop to open anything on disk.
    "file.open": async ({ path }) => {
      assertProduced(deps.db, path);
      await deps.openPath(path);
    },

    "file.reveal": async ({ path }) => {
      assertProduced(deps.db, path);
      await deps.revealPath(path);
    },

    "providers.list": async () => listProviders(deps.db),

    // Values, not a catalogue: everything a preset carries is editable in the
    // form afterwards, and an id that has moved on is corrected there rather
    // than waiting for a release.
    "providers.presets": async () => PRESETS,

    "provider.create": async (input) => {
      // The environment may hold the key: the request names the variable, and
      // only this process reads it — under the name the entry it is connecting
      // declares, and no other. A typed key wins over the named one.
      const created = createProvider(deps.db, deps.crypto, {
        ...input,
        apiKey: resolveKey(
          input.apiKey,
          input.apiKeyFromEnv,
          input.catalogId === undefined || input.catalogId === null
            ? null
            : deps.catalog.declaredEnv(input.catalogId),
        ),
      });
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

    "provider.setReasoning": async ({ providerId, modelId, level }) => {
      setReasoning(deps.db, providerId, modelId, level);
      deps.broadcast("providers.changed", {});
    },

    "settings.chooseJar": async () => {
      const path = await deps.chooseOpen("jar");
      if (path === null) return readSettings(deps.db);

      deps.db.prepare(`
        INSERT INTO setting (key, value) VALUES ('epubcheckJar', ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `).run(path);
      return readSettings(deps.db);
    },

    "settings.get": async () => readSettings(deps.db),

    "settings.set": async (patch) => {
      if (patch.concurrency !== undefined
        && (!Number.isInteger(patch.concurrency) || patch.concurrency < 1)) {
        throw new Error(`concurrency must be a positive integer, got ${patch.concurrency}`);
      }

      const write = deps.db.prepare(`
        INSERT INTO setting (key, value) VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `);
      const clear = deps.db.prepare("DELETE FROM setting WHERE key = ?");

      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        // `null` means "no value", and the row goes. Writing it through
        // `String` would store the four letters "null", which comes back as a
        // jar path that cannot exist and an error nobody can act on.
        if (value === null) clear.run(key);
        else write.run(key, String(value));
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
