import type { CreatedProject, CreateProjectRequest, ProjectSummary, Settings } from "./dto.ts";

export type { CreatedProject, CreateProjectRequest, ProjectSummary, Settings } from "./dto.ts";

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
  "project.delete": { req: { id: string; keepOutput?: string }; res: void };
  "settings.get": { req: undefined; res: Settings };
  "settings.set": { req: Partial<Settings>; res: Settings };
}

export interface Events {
  "project.changed": { id: string };
  "run.phase": { projectId: string; phase: string };
  "run.progress": { projectId: string; done: number; total: number };
}

export const INVOCATIONS = [
  "projects.list", "project.chooseEpub", "project.create", "project.delete",
  "settings.get", "settings.set",
] as const satisfies ReadonlyArray<keyof Invocations>;

export const EVENTS = [
  "project.changed", "run.phase", "run.progress",
] as const satisfies ReadonlyArray<keyof Events>;

export type Handlers = {
  [K in keyof Invocations]: (request: Invocations[K]["req"]) => Promise<Invocations[K]["res"]>;
};
