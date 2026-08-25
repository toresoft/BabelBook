import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { EVENTS, INVOCATIONS } from "../shared/channels.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { buildHandlers, type IpcDeps } from "../main/ipc.ts";

async function deps(overrides: Partial<IpcDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-ipc-"));
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  return {
    dir,
    db,
    deps: {
      db, userDataDir: dir,
      chooseEpub: async () => null,
      broadcast: () => {},
      ...overrides,
    } as IpcDeps,
  };
}

describe("the channel list", () => {
  it("has a handler for every declared invocation, and no handler for anything else", async () => {
    const { deps: d } = await deps();
    expect(Object.keys(buildHandlers(d)).sort()).toEqual([...INVOCATIONS].sort());
  });

  it("declares no channel twice", () => {
    expect(new Set(INVOCATIONS).size).toBe(INVOCATIONS.length);
    expect(new Set(EVENTS).size).toBe(EVENTS.length);
  });
});

describe("the preload bridge", () => {
  it("exposes the bridge and checks the channel against the declared list", async () => {
    const source = await readFile("app/preload/preload.ts", "utf8");

    expect(source).toContain("contextBridge.exposeInMainWorld");
    expect(source).toContain("INVOCATIONS");
    expect(source).toContain("EVENTS");
    expect(source).not.toContain("node:fs");
  });

  it("keeps the renderer away from Node entirely", async () => {
    const source = await readFile("app/main/window.ts", "utf8");

    expect(source).toContain("contextIsolation: true");
    expect(source).toContain("sandbox: true");
    expect(source).toContain("nodeIntegration: false");
  });
});

describe("project.chooseEpub", () => {
  it("is the only way a path enters the main process", async () => {
    const chooseEpub = vi.fn().mockResolvedValue({ path: "/books/one.epub", name: "one.epub" });
    const { deps: d } = await deps({ chooseEpub });

    expect(await buildHandlers(d)["project.chooseEpub"](undefined))
      .toEqual({ path: "/books/one.epub", name: "one.epub" });
    expect(chooseEpub).toHaveBeenCalled();
  });

  it("answers null when the user cancelled", async () => {
    const { deps: d } = await deps();
    expect(await buildHandlers(d)["project.chooseEpub"](undefined)).toBeNull();
  });
});

describe("project.create and project.delete", () => {
  it("creates a project through the channel and tells the window it changed", async () => {
    const broadcast = vi.fn();
    const { dir, db, deps: d } = await deps({ broadcast });
    const epub = join(dir, "book.epub");
    await writeFile(epub, await buildEpub({
      title: "Through IPC", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    }));

    const created = await buildHandlers(d)["project.create"]({ epubPath: epub, targetLanguage: "it" });

    expect(created.title).toBe("Through IPC");
    expect(broadcast).toHaveBeenCalledWith("project.changed", { id: created.id });
    expect((db.prepare("SELECT count(*) AS n FROM project").get() as { n: number }).n).toBe(1);
  });

  it("deletes the project and its workspace", async () => {
    const { dir, db, deps: d } = await deps();
    const epub = join(dir, "book.epub");
    await writeFile(epub, await buildEpub({ documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }] }));

    const handlers = buildHandlers(d);
    const created = await handlers["project.create"]({ epubPath: epub, targetLanguage: "it" });
    await handlers["project.delete"]({ id: created.id });

    expect((db.prepare("SELECT count(*) AS n FROM project").get() as { n: number }).n).toBe(0);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "projects", created.id))).toBe(false);
  });

  it("refuses to delete a project that is not there, instead of reporting success", async () => {
    const { deps: d } = await deps();
    await expect(buildHandlers(d)["project.delete"]({ id: "ghost" })).rejects.toThrow();
  });
});

describe("settings", () => {
  it("answers with defaults before anything was ever set", async () => {
    const { deps: d } = await deps();

    expect(await buildHandlers(d)["settings.get"](undefined)).toMatchObject({
      autoAcceptTerms: false, autoAcceptExclusions: false, concurrency: 2,
    });
  });

  it("keeps what was set, and leaves the rest alone", async () => {
    const { deps: d } = await deps();
    const handlers = buildHandlers(d);

    const after = await handlers["settings.set"]({ autoAcceptTerms: true });

    expect(after.autoAcceptTerms).toBe(true);
    expect(after.concurrency).toBe(2);
    expect(await handlers["settings.get"](undefined)).toEqual(after);
  });

  it("refuses a concurrency that would make no sense", async () => {
    const { deps: d } = await deps();
    await expect(buildHandlers(d)["settings.set"]({ concurrency: 0 })).rejects.toThrow();
  });
});

describe("project.update", () => {
  const created = async () => {
    const { dir, db, deps: d } = await deps();
    const epub = join(dir, "book.epub");
    await writeFile(epub, await buildEpub({
      language: "und", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    }));
    const handlers = buildHandlers(d);
    return { db, handlers, project: await handlers["project.create"]({ epubPath: epub, targetLanguage: "it" }) };
  };

  it("confirms the language and moves the project out of needs-language", async () => {
    const { db, handlers, project } = await created();
    expect((db.prepare("SELECT state FROM project WHERE id=?").get(project.id) as { state: string }).state)
      .toBe("needs-language");

    await handlers["project.update"]({ id: project.id, sourceLanguage: "en" });

    expect(db.prepare("SELECT state, source_language FROM project WHERE id=?").get(project.id))
      .toMatchObject({ state: "ready", source_language: "en" });
  });

  it("leaves alone what the request does not name", async () => {
    const { db, handlers, project } = await created();
    await handlers["project.update"]({ id: project.id, description: "Secondo volume" });

    expect(db.prepare("SELECT target_language, description FROM project WHERE id=?").get(project.id))
      .toMatchObject({ target_language: "it", description: "Secondo volume" });
  });

  it("refuses a project that is not there", async () => {
    const { deps: d } = await deps();
    await expect(buildHandlers(d)["project.update"]({ id: "ghost", targetLanguage: "fr" }))
      .rejects.toThrow();
  });
});
