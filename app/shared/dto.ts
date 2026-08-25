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

export interface UpdateProjectRequest {
  id: string;
  targetLanguage?: string;
  sourceLanguage?: string | null;
  description?: string;
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

/**
 * A failure, as it crosses the IPC boundary.
 *
 * Electron serialises a rejected invocation down to its message: a custom
 * class and its fields do not survive. Everything this application knows how to
 * say about a failure is a code plus its details, so both are packed into the
 * message and unpacked on the other side. Without that, "this is a MOBI"
 * arrives as a sentence nobody can translate or branch on.
 */
export interface IpcFailure {
  code: string;
  [detail: string]: unknown;
}

const MARKER = "babelbook-failure:";

export function packFailure(error: unknown): string {
  const failure = error as { code?: unknown; message?: unknown };
  const code = typeof failure.code === "string" ? failure.code : "UNKNOWN";

  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error as object)) {
    if (key !== "code" && key !== "stack" && (typeof value === "string" || typeof value === "number")) {
      details[key] = value;
    }
  }

  return MARKER + JSON.stringify({
    code,
    message: typeof failure.message === "string" ? failure.message : String(error),
    ...details,
  });
}

export function unpackFailure(error: unknown): IpcFailure {
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return { code: "UNKNOWN" };

  const at = message.indexOf(MARKER);
  if (at === -1) return { code: "UNKNOWN", message };

  try {
    return JSON.parse(message.slice(at + MARKER.length)) as IpcFailure;
  } catch {
    return { code: "UNKNOWN", message };
  }
}
