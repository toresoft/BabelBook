import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LogLevel, LogRecord, LogSink, ProjectStore, RunEvent } from "../../../core/ports.ts";

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

/**
 * A level as `run_event` records it. `debug` is not recorded at all.
 *
 * That null is the whole rule of the two logs, written once: everything goes
 * to the file, and only what a reader would want goes to the table the
 * Registro is built from.
 */
const SEVERITY_OF: Record<LogLevel, RunEvent["severity"] | null> = {
  debug: null,
  info: "info",
  warn: "warning",
  error: "error",
};

/**
 * The other half of the pair: the sink the reader's log is built from.
 *
 * `run_event` is where `runLog` looks, so a run that wrote only a file left
 * the retry lines where nobody ever looks — and "am I retrying?" is the
 * question the whole log was rebuilt to answer.
 *
 * `record` is synchronous and `event` is not, so the write is started and not
 * waited for. That is deliberate: an observation that can fail a run, or slow
 * one down by a round trip across a process boundary per line, is worse than
 * no observation. The proxy delivers in order, so the lines arrive in order.
 */
export function storeSink(store: ProjectStore): LogSink {
  return {
    record(entry: LogRecord): void {
      const severity = SEVERITY_OF[entry.level];
      if (severity === null) return;
      void store.event({
        code: entry.code,
        severity,
        payload: entry.detail ?? {},
      }).catch(() => {
        // A store with no run to attribute an event to refuses, and it is
        // right to: what it must not do is take the run down for a log line.
      });
    },
  };
}

/** One record, every destination. A sink that throws does not silence the rest. */
export function bothSinks(...sinks: LogSink[]): LogSink {
  return {
    record(entry: LogRecord): void {
      for (const sink of sinks) {
        try {
          sink.record(entry);
        } catch {
          // Already swallowed by each sink; this is the net under the net.
        }
      }
    },
  };
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
    try {
      for (const process of ["main", "engine"] as const) {
        await rm(join(dir, `run-${runId}.${process}.ndjson`), { force: true });
      }
    } catch {
      // Best-effort by design: prune runs at the start of a run, and one that
      // can fail a run over an old file is worse than an old file left behind.
      continue;
    }
  }
}
