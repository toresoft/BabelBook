import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LogRecord, LogSink } from "../../../core/ports.ts";

/**
 * The whole story of a run, on disk, in the language nobody has to translate.
 *
 * The reader's Registro is curated: it holds what a person translating a book
 * needs to know. This holds everything, so that the run that went wrong can be
 * understood afterwards rather than reproduced. `debug` exists only here.
 *
 * Two processes write, so two files: the engine cannot be told to wait for the
 * main process and interleaved appends from two writers are not guaranteed to
 * stay whole. They are merged when read, by timestamp — which is the same
 * merge `runLog` already does with its own two sources.
 */

const RUN_FILE = /^run-(.+)\.(main|engine)\.ndjson$/;
const DEFAULT_LIMIT = 2000;
const DEFAULT_KEEP = 5;

export function diagnosticsDir(workspaceRoot: string): string {
  const dir = join(workspaceRoot, "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Reported by the sink's own silence, not by throwing here: a diagnostic
    // that can stop a run is worse than one nobody reads.
  }
  return dir;
}

export interface FileSinkInput {
  dir: string;
  process: "main" | "engine";
  runId: string;
  projectId: string;
  /** Read at write time, because a run walks through several. */
  phase?: () => string | null;
}

/**
 * A sink that appends, synchronously and without a queue.
 *
 * Synchronous on purpose: the engine process can be killed at the end of a
 * run, and a buffered writer would lose exactly the last lines — the ones
 * that say why it ended.
 */
export function fileSink(input: FileSinkInput): LogSink & { close(): void } {
  const path = join(input.dir, `run-${input.runId}.${input.process}.ndjson`);
  let broken = false;

  return {
    record(entry: LogRecord): void {
      if (broken) return;
      try {
        const phase = input.phase?.() ?? null;
        appendFileSync(path, `${JSON.stringify({
          at: new Date().toISOString(),
          level: entry.level,
          code: entry.code,
          process: input.process,
          projectId: input.projectId,
          runId: input.runId,
          ...(phase === null ? {} : { phase }),
          ...entry.detail,
        })}\n`, "utf8");
      } catch {
        // Once is enough to know the directory is not writable; trying on
        // every line would turn one broken path into thousands of syscalls.
        broken = true;
      }
    },

    close(): void {
      broken = true;
    },
  };
}

/** The two files of one run, as one sequence, tail first trimmed to `limit`. */
export async function readDiagnostics(
  dir: string,
  runId: string,
  limit = DEFAULT_LIMIT,
): Promise<{ lines: string[]; path: string }> {
  const lines: Array<{ at: string; raw: string }> = [];

  for (const process of ["main", "engine"] as const) {
    let content: string;
    try {
      content = await readFile(join(dir, `run-${runId}.${process}.ndjson`), "utf8");
    } catch {
      continue;
    }
    for (const raw of content.split("\n")) {
      if (raw.trim() === "") continue;
      let at = "";
      try {
        at = String((JSON.parse(raw) as { at?: unknown }).at ?? "");
      } catch {
        // A half-written last line is still worth showing; it sorts first,
        // which is where an unreadable line does least harm.
      }
      lines.push({ at, raw });
    }
  }

  lines.sort((one, other) => one.at.localeCompare(other.at));
  return { lines: lines.slice(-limit).map((line) => line.raw), path: dir };
}

/** Past this the application file is rolled over; one spare is kept. */
const APP_LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The one file for what happens outside any run.
 *
 * Verifying a provider, refreshing the catalogue, opening the database: none
 * of them has a `runId` or a workspace, and `run_event` demands both. None
 * of them belongs to a book either, so none of them reaches a Registro — the
 * screen that failed says so itself, with `tell()`. This is only for
 * afterwards.
 */
export function appSink(userDataDir: string): LogSink {
  const dir = join(userDataDir, "logs");
  const path = join(dir, "app.ndjson");
  let broken = false;

  return {
    record(entry: LogRecord): void {
      if (broken) return;
      try {
        mkdirSync(dir, { recursive: true });
        // Rolled by size rather than by date: this file has no run to belong
        // to, so nothing else bounds it.
        try {
          if (statSync(path).size >= APP_LOG_MAX_BYTES) renameSync(path, join(dir, "app.1.ndjson"));
        } catch {
          // No file yet, which is the ordinary case on the first line.
        }
        appendFileSync(path, `${JSON.stringify({
          at: new Date().toISOString(),
          level: entry.level,
          code: entry.code,
          process: "main",
          ...entry.detail,
        })}\n`, "utf8");
      } catch {
        broken = true;
      }
    },
  };
}

/** Keeps the newest `keep` runs. Called when a run starts, not when it ends. */
export async function pruneDiagnostics(dir: string, keep = DEFAULT_KEEP): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  const newest = new Map<string, number>();
  for (const name of names) {
    const match = RUN_FILE.exec(name);
    if (match === null) continue;
    try {
      const when = (await stat(join(dir, name))).mtimeMs;
      newest.set(match[1]!, Math.max(newest.get(match[1]!) ?? 0, when));
    } catch {
      continue;
    }
  }

  const doomed = [...newest.entries()]
    .sort((one, other) => other[1] - one[1])
    .slice(keep)
    .map(([runId]) => runId);

  for (const runId of doomed) {
    for (const process of ["main", "engine"] as const) {
      await rm(join(dir, `run-${runId}.${process}.ndjson`), { force: true });
    }
  }
}
