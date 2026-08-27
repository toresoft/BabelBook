import type {
  CatalogEntry, CatalogState, CreatedProject, CreateProjectRequest, ExclusionGroup, GlossaryView,
  InvalidationPreview, ProjectSummary,
  Provider, ProviderInput, ProviderModel, ProviderPatch, ProviderPreset, Settings, TermRow, TermRule,
  ProjectDetail, Report, UnitQuery, UnitRow, UpdateProjectRequest, VerifyOutcome, LocalRuntime,
} from "./dto.ts";

export type {
  CatalogEntry, CatalogState,
  CreatedProject, CreateProjectRequest, ExcludedState, ExclusionGroup, GlossaryTerm, GlossaryView,
  InvalidationPreview,
  ProjectSummary, Provider, ProviderInput, ProviderModel, ProviderPatch, ProviderPreset, Settings,
  ProjectDetail, Report, ReportLine, TermRow, TermRule, UnitQuery, UnitRow,
  UpdateProjectRequest, VerifyOutcome, LocalRuntime,
} from "./dto.ts";

export const DEFAULT_SETTINGS: Settings = {
  uiLanguage: "it",
  // Both gates stop by default. Skipping them is a choice the user makes
  // knowingly; making it for them would spend money on terminology nobody saw.
  autoAcceptTerms: false,
  autoAcceptExclusions: false,
  concurrency: 2,
  epubcheckJar: null,
};

/**
 * Every channel, declared once.
 *
 * Main, preload and renderer all import this file, so a channel added in one
 * of them stops compiling in the other two. That is the whole point: three
 * copies of a channel list drift, and the drift shows up as a feature that
 * silently does nothing.
 */

/** The destructive acts that are asked about before they happen. */
export const CONFIRM_KINDS = [
  "deleteProject", "deleteProvider", "deleteGlossary", "abandonProject",
] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];

export interface Invocations {
  /**
   * A question, and the answer. The words come from the catalogue on the main
   * side, and the dialog is the operating system's: it follows the theme the
   * rest of the desktop follows.
   */
  "ui.confirm": {
    req: { kind: ConfirmKind; detail?: Record<string, string | number> };
    res: { confirmed: boolean };
  };
  "projects.list": { req: { filter?: string }; res: ProjectSummary[] };
  "project.chooseEpub": { req: undefined; res: { path: string; name: string } | null };
  "project.create": { req: CreateProjectRequest; res: CreatedProject };
  "project.update": { req: UpdateProjectRequest; res: void };
  "project.delete": { req: { id: string; keepOutput?: string }; res: void };
  /** Null when the project is gone: another window may have deleted it. */
  "project.get": { req: { id: string }; res: ProjectDetail | null };
  "units.list": {
    req: { projectId: string } & UnitQuery;
    res: { units: UnitRow[]; total: number };
  };
  "run.start": { req: { projectId: string }; res: void };
  "run.pause": { req: { projectId: string }; res: void };
  "run.approve": { req: { projectId: string; gate: "terms" | "code" }; res: void };
  "terms.list": { req: { projectId: string }; res: TermRow[] };
  "terms.decide": {
    req: {
      projectId: string;
      decisions: Array<{
        id: string; approval: "approved" | "rejected";
        target?: string | null; rule?: TermRule; note?: string | null;
      }>;
    };
    res: { approved: number; rejected: number };
  };
  "terms.add": {
    req: {
      projectId: string; source: string; target: string | null;
      rule: TermRule; sense?: string | null; note: string | null;
    };
    res: TermRow;
  };
  "terms.promote": { req: { termId: string; glossaryId: string }; res: { version: number } };
  "terms.previewInvalidation": {
    req: { projectId: string; termIds: string[] };
    res: InvalidationPreview;
  };
  "terms.invalidate": { req: { projectId: string; unitIds: string[] }; res: { removed: number } };
  "exclusions.list": { req: { projectId: string }; res: ExclusionGroup[] };
  "exclusions.force": {
    req: { projectId: string; changes: Array<{ unitId: string; state: "translate" | "code" }> };
    res: { toTranslate: number; toCode: number };
  };
  "exclusions.clear": { req: { projectId: string; unitIds: string[] }; res: { cleared: number } };
  "glossaries.list": { req: undefined; res: GlossaryView[] };
  "glossary.save": { req: GlossaryView; res: GlossaryView };
  "glossary.delete": { req: { id: string }; res: { detachedFrom: number } };
  "glossary.import": { req: { markdown: string }; res: GlossaryView };
  "glossary.export": { req: { id: string }; res: { markdown: string } };
  /** Opens a dialog, reads the file in the main process, answers with what it parsed. */
  "glossary.importFile": { req: undefined; res: GlossaryView | null };
  /** Opens a save dialog and writes it. Null when the dialog was dismissed. */
  "glossary.exportFile": { req: { id: string }; res: { path: string } | null };
  "glossary.attach": {
    req: { projectId: string; glossaryId: string; attached: boolean };
    res: undefined;
  };
  /** Null when the project has never been run: there is nothing to report on. */
  "report.get": { req: { projectId: string }; res: Report | null };
  /** Hands a produced file to the desktop. The window never names a path it was not given. */
  "file.open": { req: { path: string }; res: void };
  "file.reveal": { req: { path: string }; res: void };
  "providers.list": { req: undefined; res: Provider[] };
  "providers.presets": { req: undefined; res: ProviderPreset[] };
  "provider.create": { req: ProviderInput; res: Provider };
  "provider.update": { req: ProviderPatch & { id: string }; res: Provider };
  "provider.delete": { req: { id: string }; res: void };
  "provider.verify": { req: { providerId: string; modelId: string }; res: VerifyOutcome };
  /** Asks the machine itself which local runtimes are running right now. */
  "local.runtimes": { req: undefined; res: LocalRuntime[] };
  /**
   * Searches the provider catalogue. The typed key is never part of this
   * call: searching reads the catalogue, and only finding models asks an
   * endpoint anything.
   */
  "catalog.search": { req: { query: string }; res: CatalogEntry[] };
  /**
   * What one catalogue entry serves: the endpoint's list when the entry
   * declares a URL to ask, its own otherwise. The key crosses renderer→main
   * exactly once, like `provider.create`, and never comes back.
   */
  "catalog.models": { req: { entryId: string; apiKey: string | null }; res: ProviderModel[] };
  /** Asks any OpenAI-compatible URL what it serves, with no metadata to add. */
  "provider.discover": { req: { baseUrl: string; apiKey: string | null }; res: ProviderModel[] };
  /** How old the catalogue in use is. One line, no alarm. */
  "catalog.state": { req: undefined; res: CatalogState };
  /**
   * Asks the network for a newer catalogue, when the user asks. A failed
   * refresh changes nothing and says so without alarm.
   */
  "catalog.refresh": { req: undefined; res: CatalogState };
  /** Installs a catalogue chosen from a file, for a machine without a network. */
  "catalog.importFile": { req: undefined; res: CatalogState };
  "settings.get": { req: undefined; res: Settings };
  "settings.set": { req: Partial<Settings>; res: Settings };
  /** Asks for the EPUBCheck jar and stores it. Returns the settings as they now stand. */
  "settings.chooseJar": { req: undefined; res: Settings };
}

export interface Events {
  "project.changed": { id: string };
  "providers.changed": Record<string, never>;
  "run.phase": { projectId: string; phase: string };
  "run.progress": { projectId: string; done: number; total: number };
}

export const INVOCATIONS = [
  "ui.confirm",
  "projects.list", "project.chooseEpub", "project.create", "project.update", "project.delete",
  "project.get", "units.list",
  "run.start", "run.pause", "run.approve",
  "terms.list", "terms.decide", "terms.add", "terms.promote",
  "terms.previewInvalidation", "terms.invalidate",
  "exclusions.list", "exclusions.force", "exclusions.clear",
  "glossaries.list", "glossary.save", "glossary.delete",
  "glossary.import", "glossary.export", "glossary.attach",
  "glossary.importFile", "glossary.exportFile",
  "report.get", "file.open", "file.reveal",
  "providers.list", "providers.presets",
  "provider.create", "provider.update", "provider.delete", "provider.verify",
  "local.runtimes",
  "catalog.search", "catalog.models", "provider.discover", "catalog.state",
  "catalog.refresh", "catalog.importFile",
  "settings.get", "settings.set", "settings.chooseJar",
] as const satisfies ReadonlyArray<keyof Invocations>;

export const EVENTS = [
  "project.changed", "providers.changed", "run.phase", "run.progress",
] as const satisfies ReadonlyArray<keyof Events>;

export type Handlers = {
  [K in keyof Invocations]: (request: Invocations[K]["req"]) => Promise<Invocations[K]["res"]>;
};
