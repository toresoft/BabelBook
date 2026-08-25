import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface EpubcheckMessage {
  id: string;
  severity: "fatal" | "error" | "warning" | "usage";
  message: string;
  path?: string;
}

export interface EpubcheckResult {
  ran: boolean;
  /** a code, not a sentence */
  reason?: "no-jar" | "no-java" | "crashed";
  messages: EpubcheckMessage[];
}

export const VENDORED_JAR = join("vendor", "epubcheck", "epubcheck.jar");

/**
 * A jar named by the environment is authoritative: if it is not there the check
 * does not run, and it does not fall back on the vendored one. Whoever named a
 * jar wants that jar.
 *
 * `vendor/` is gitignored, so on a fresh clone there is no jar at all and the
 * gate degrades to "did not run". It has to say so, and must never fake a pass.
 */
export function findJar(env: NodeJS.ProcessEnv, cwd: string): string | null {
  const named = env.EPUBCHECK_JAR;
  if (named !== undefined && named !== "") return existsSync(named) ? named : null;
  const vendored = join(cwd, VENDORED_JAR);
  return existsSync(vendored) ? vendored : null;
}

function severityOf(raw: unknown): EpubcheckMessage["severity"] {
  const value = String(raw ?? "").toLowerCase();
  if (value === "fatal" || value === "error" || value === "warning") return value;
  return "usage";
}

function parseMessages(json: string): EpubcheckMessage[] {
  const parsed: unknown = JSON.parse(json);
  const raw = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return [];

  return raw.map((entry): EpubcheckMessage => {
    const item = entry as {
      ID?: string;
      severity?: string;
      message?: string;
      locations?: Array<{ path?: string }>;
    };
    const path = item.locations?.[0]?.path;
    return {
      id: item.ID ?? "",
      severity: severityOf(item.severity),
      message: item.message ?? "",
      ...(path === undefined ? {} : { path }),
    };
  });
}

/**
 * Runs EPUBCheck if a jar and a JVM are there. A missing `java`, an abnormal
 * exit or unreadable JSON becomes `ran: false` with the matching reason — never
 * an error that stops the pipeline.
 */
export function runEpubcheck(
  epubPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EpubcheckResult> {
  const jar = findJar(env, process.cwd());
  if (jar === null) return Promise.resolve({ ran: false, reason: "no-jar", messages: [] });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("java", ["-jar", jar, "--json", "-", epubPath], { env });
    } catch {
      resolve({ ran: false, reason: "no-java", messages: [] });
      return;
    }

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.resume();

    child.on("error", () => resolve({ ran: false, reason: "no-java", messages: [] }));
    child.on("close", () => {
      // A non-zero exit is how EPUBCheck reports a book with errors, so the
      // JSON is read first and the exit code never decides on its own.
      try {
        resolve({ ran: true, messages: parseMessages(stdout) });
      } catch {
        resolve({ ran: false, reason: "crashed", messages: [] });
      }
    });
  });
}

function key(message: EpubcheckMessage): string {
  return `${message.id}|${message.path ?? ""}|${message.message}`;
}

/**
 * What this run introduced, and nothing else. A book can arrive already
 * non-conformant, and blaming the translation for a defect that was there
 * before is a false accusation that costs hours.
 */
export function introducedMessages(
  before: EpubcheckResult,
  after: EpubcheckResult,
): EpubcheckMessage[] {
  if (!before.ran || !after.ran) return [];

  const budget = new Map<string, number>();
  for (const message of before.messages) {
    const id = key(message);
    budget.set(id, (budget.get(id) ?? 0) + 1);
  }

  const introduced: EpubcheckMessage[] = [];
  for (const message of after.messages) {
    const id = key(message);
    const left = budget.get(id) ?? 0;
    if (left > 0) budget.set(id, left - 1);
    else introduced.push(message);
  }
  return introduced;
}
