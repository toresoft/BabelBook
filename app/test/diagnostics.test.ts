import { chmodSync } from "node:fs";
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appSink, diagnosticsDir, fileSink, pruneDiagnostics, readDiagnostics,
} from "../main/run/diagnostics.ts";

const workspace = () => mkdtemp(join(tmpdir(), "babelbook-diag-"));

describe("the diagnostic file", () => {
  it("writes one JSON object per line, with the run's own facts", async () => {
    const dir = diagnosticsDir(await workspace());
    const sink = fileSink({ dir, process: "engine", runId: "r1", projectId: "p1", phase: () => "translate" });

    sink.record({ level: "warn", code: "provider-retry", detail: { attempt: 2, waitMs: 4000 } });
    sink.record({ level: "debug", code: "call-finished", detail: { tokensOut: 120 } });
    sink.close();

    const written = await readFile(join(dir, "run-r1.engine.ndjson"), "utf8");
    const lines = written.trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: "warn", code: "provider-retry", process: "engine",
      runId: "r1", projectId: "p1", phase: "translate", attempt: 2, waitMs: 4000,
    });
    expect(typeof lines[0].at).toBe("string");
  });

  /**
   * Two processes, two files, one story: the same merge `runLog` already does
   * with its two sources, for the same reason — neither can be told to wait
   * for the other, and a timestamp is the only order both agree on.
   */
  it("reads the two processes back as one sequence", async () => {
    const dir = diagnosticsDir(await workspace());
    await writeFile(join(dir, "run-r1.engine.ndjson"),
      `{"at":"2026-09-01T10:00:02.000Z","code":"b"}\n{"at":"2026-09-01T10:00:04.000Z","code":"d"}\n`);
    await writeFile(join(dir, "run-r1.main.ndjson"),
      `{"at":"2026-09-01T10:00:01.000Z","code":"a"}\n{"at":"2026-09-01T10:00:03.000Z","code":"c"}\n`);

    const { lines } = await readDiagnostics(dir, "r1");
    expect(lines.map((line) => JSON.parse(line).code)).toEqual(["a", "b", "c", "d"]);
  });

  it("answers with the last lines when there are more than asked for", async () => {
    const dir = diagnosticsDir(await workspace());
    const sink = fileSink({ dir, process: "main", runId: "r1", projectId: "p1" });
    for (let at = 0; at < 50; at++) sink.record({ level: "debug", code: `n${at}` });
    sink.close();

    const { lines } = await readDiagnostics(dir, "r1", 10);
    expect(lines).toHaveLength(10);
    expect(JSON.parse(lines[9]!).code).toBe("n49");
  });

  it("answers with nothing rather than throwing when no run wrote anything", async () => {
    const dir = diagnosticsDir(await workspace());
    const { lines, path } = await readDiagnostics(dir, "never-ran");
    expect(lines).toEqual([]);
    expect(path).toBe(dir);
  });

  it("keeps the last five runs and forgets the rest", async () => {
    const dir = diagnosticsDir(await workspace());
    for (const runId of ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]) {
      const sink = fileSink({ dir, process: "main", runId, projectId: "p1" });
      sink.record({ level: "info", code: "x" });
      sink.close();
      await new Promise((resume) => setTimeout(resume, 5));
    }

    await pruneDiagnostics(dir, 5);

    expect((await readDiagnostics(dir, "r1")).lines).toEqual([]);
    expect((await readDiagnostics(dir, "r2")).lines).toEqual([]);
    expect((await readDiagnostics(dir, "r7")).lines).toHaveLength(1);
  });

  it("prunes best-effort rather than throwing on a directory it cannot write to", async () => {
    const dir = diagnosticsDir(await workspace());
    const sink = fileSink({ dir, process: "main", runId: "r1", projectId: "p1" });
    sink.record({ level: "info", code: "x" });
    sink.close();

    try {
      chmodSync(dir, 0o500);
      // `keep` zero: one run, doomed, so the deletion path is actually taken.
      await expect(pruneDiagnostics(dir, 0)).resolves.toBeUndefined();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  /**
   * Verifying a provider, refreshing the catalogue, opening the database at
   * start-up: none of them has a run, and `run_event` demands one. They go to
   * one application-wide file instead, and to no Registro — a Registro belongs
   * to a book, and none of those belongs to any book.
   */
  it("writes what happens outside a run to one application file", async () => {
    const userData = await workspace();
    const sink = appSink(userData);
    sink.record({ level: "error", code: "PROVIDER_UNAUTHORIZED", detail: { screen: "providers" } });

    const written = await readFile(join(userData, "logs", "app.ndjson"), "utf8");
    expect(JSON.parse(written.trim())).toMatchObject({
      level: "error", code: "PROVIDER_UNAUTHORIZED", screen: "providers", process: "main",
    });
  });

  it("rotates the application file once it grows past its bound", async () => {
    const userData = await workspace();
    const sink = appSink(userData);
    const wide = "x".repeat(4096);
    for (let at = 0; at < 700; at++) sink.record({ level: "info", code: "n", detail: { wide } });

    const dir = join(userData, "logs");
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["app.ndjson", "app.1.ndjson"]));
    expect((await stat(join(dir, "app.ndjson"))).size).toBeLessThan(2 * 1024 * 1024);
  });

  /** A sink that can fail a run is worse than a sink nobody reads. */
  it("swallows a directory it cannot write to", async () => {
    const sink = fileSink({
      dir: "/proc/nowhere/babelbook", process: "main", runId: "r1", projectId: "p1",
    });
    expect(() => sink.record({ level: "error", code: "x" })).not.toThrow();
    expect(() => sink.close()).not.toThrow();
  });
});
