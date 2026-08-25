import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The core may not reach for its host.
 *
 * Electron and the database belong to `app/`; a provider package belongs to the
 * adapters. If any of them appears here, the core has stopped being testable on
 * its own and nothing announces it.
 */
const FORBIDDEN = [/from\s+["']electron["']/, /from\s+["']node:sqlite["']/, /@ai-sdk\//];

/** Resolved from this file, not from the working directory the runner chose. */
const CORE_ROOT = join(import.meta.dirname, "..");

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * A concrete model must not be nameable from the model-facing core.
 *
 * `translate/` and `analyze/` decide how to ask; which model answers is the
 * adapters' business. A name that slips into a prompt or a comment here is how
 * a provider-agnostic layer stops being one, and it does not announce itself.
 */
const MODEL_NAMES = [/claude-/, /gpt-[0-9]/, /deepseek-/, /gemini-/, /llama-/, /mistral-/];

describe("core boundary", () => {
  it("imports neither Electron, nor node:sqlite, nor a provider package", async () => {
    const offenders: string[] = [];
    for (const file of await sources(CORE_ROOT)) {
      const text = await readFile(file, "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.test(text)) offenders.push(`${file}: ${rule}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds the sources it claims to be scanning", async () => {
    expect((await sources(CORE_ROOT)).length).toBeGreaterThan(0);
  });

  it("neither translate nor analyze names a concrete model", async () => {
    const offenders: string[] = [];
    for (const area of ["translate", "analyze"]) {
      for (const file of await sources(join(CORE_ROOT, area))) {
        const text = await readFile(file, "utf8");
        for (const rule of MODEL_NAMES) {
          if (rule.test(text)) offenders.push(`${file}: ${rule}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
