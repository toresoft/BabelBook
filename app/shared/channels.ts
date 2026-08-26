import type {
  CreatedProject, CreateProjectRequest, ExclusionGroup, GlossaryView, InvalidationPreview, ProjectSummary,
  Provider, ProviderInput, ProviderPatch, ProviderPreset, Settings, TermRow, TermRule,
  ProjectDetail, Report, UnitQuery, UnitRow, UpdateProjectRequest, VerifyOutcome,
} from "./dto.ts";

export type {
  CreatedProject, CreateProjectRequest, ExcludedState, ExclusionGroup, GlossaryTerm, GlossaryView,
  InvalidationPreview,
  ProjectSummary, Provider, ProviderInput, ProviderModel, ProviderPatch, ProviderPreset, Settings,
  ProjectDetail, Report, ReportLine, TermRow, TermRule, UnitQuery, UnitRow,
  UpdateProjectRequest, VerifyOutcome,
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
export interface Invocations {
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
  "glossary.attach": {
    req: { projectId: string; glossaryId: string; attached: boolean };
    res: undefined;
  };
  /** Null when the project has never been run: there is nothing to report on. */
  "report.get": { req: { projectId: string }; res: Report | null };
  "providers.list": { req: undefined; res: Provider[] };
  "providers.presets": { req: undefined; res: ProviderPreset[] };
  "provider.create": { req: ProviderInput; res: Provider };
  "provider.update": { req: ProviderPatch & { id: string }; res: Provider };
  "provider.delete": { req: { id: string }; res: void };
  "provider.verify": { req: { providerId: string; modelId: string }; res: VerifyOutcome };
  "settings.get": { req: undefined; res: Settings };
  "settings.set": { req: Partial<Settings>; res: Settings };
}

export interface Events {
  "project.changed": { id: string };
  "providers.changed": Record<string, never>;
  "run.phase": { projectId: string; phase: string };
  "run.progress": { projectId: string; done: number; total: number };
}

export const INVOCATIONS = [
  "projects.list", "project.chooseEpub", "project.create", "project.update", "project.delete",
  "project.get", "units.list",
  "run.start", "run.pause", "run.approve",
  "terms.list", "terms.decide", "terms.add", "terms.promote",
  "terms.previewInvalidation", "terms.invalidate",
  "exclusions.list", "exclusions.force", "exclusions.clear",
  "glossaries.list", "glossary.save", "glossary.delete",
  "glossary.import", "glossary.export", "glossary.attach",
  "report.get",
  "providers.list", "providers.presets",
  "provider.create", "provider.update", "provider.delete", "provider.verify",
  "settings.get", "settings.set",
] as const satisfies ReadonlyArray<keyof Invocations>;

export const EVENTS = [
  "project.changed", "providers.changed", "run.phase", "run.progress",
] as const satisfies ReadonlyArray<keyof Events>;

export type Handlers = {
  [K in keyof Invocations]: (request: Invocations[K]["req"]) => Promise<Invocations[K]["res"]>;
};
