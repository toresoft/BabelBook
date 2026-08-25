/**
 * The shapes that cross the IPC boundary.
 *
 * Plain data, defined here and depending on nothing: the renderer compiles
 * this file, and a type borrowed from the core would drag the EPUB layer — and
 * its Node-only declarations — into the window's compilation. A serialisation
 * boundary should carry its own vocabulary anyway; what the main process
 * happens to use internally is not the contract.
 */

export interface CreateProjectRequest {
  epubPath: string;
  targetLanguage: string;
  sourceLanguage?: string;
  description?: string;
  providerId?: string;
  modelId?: string;
}

export type LayoutKind = "reflowable" | "pre-paginated" | "mixed";

export interface LayoutSummary {
  book: LayoutKind;
  prePaginated: number;
  documents: number;
}

export interface CreatedProject {
  id: string;
  title: string;
  author?: string;
  coverPath: string | null;
  declaredLanguage: string | null;
  documents: number;
  units: { total: number; work: number; byState: Record<string, number> };
  words: number;
  layout: LayoutSummary;
  hasOverlays: boolean;
}

export interface ProjectSummary {
  id: string;
  title: string;
  author?: string;
  coverPath: string | null;
  sourceLanguage: string | null;
  targetLanguage: string;
  state: string;
  progress: { done: number; total: number };
  layout: LayoutKind;
  createdAt: string;
}

export interface Settings {
  uiLanguage: string;
  autoAcceptTerms: boolean;
  autoAcceptExclusions: boolean;
  concurrency: number;
  epubcheckJar: string | null;
}
