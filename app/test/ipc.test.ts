import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { EVENTS, INVOCATIONS, type LocalRuntime } from "../shared/channels.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { buildHandlers, type IpcDeps } from "../main/ipc.ts";
import { readKey } from "../main/providers/store.ts";

/**
 * A keyring that actually hides what it is given.
 *
 * Base64 rather than a prefix over the plaintext: a fake whose output still
 * contains the key could not be used to prove the key is not stored in the
 * clear, and the assertion would pass while saying nothing.
 */
export const testCrypto = {
  isAvailable: () => true,
  encrypt: (plain: string) =>
    Buffer.from(Buffer.from(`enc:${plain}`, "utf8").toString("base64"), "utf8"),
  decrypt: (blob: Buffer) =>
    Buffer.from(blob.toString("utf8"), "base64").toString("utf8").replace(/^enc:/, ""),
};

async function deps(overrides: Partial<IpcDeps> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-ipc-"));
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  return {
    dir,
    db,
    deps: {
      db, userDataDir: dir,
      crypto: testCrypto,
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

describe("local.runtimes", () => {
  it("answers with whatever the probe found, and nothing else", async () => {
    // The probe itself is tested against fake servers in local.test.ts; what
    // this checks is the plumbing: one call, no request, runtimes as they are.
    const found: LocalRuntime[] = [
      {
        id: "ollama", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama", models: ["gemma3:12b"],
      },
    ];
    const { deps: d } = await deps({ probeLocalRuntimes: async () => found });

    expect(await buildHandlers(d)["local.runtimes"](undefined)).toEqual(found);
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

  it("attaches the provider and model the user chose for this book", async () => {
    const { db, handlers, project } = await created();
    await handlers["project.update"]({ id: project.id, providerId: "pv1", modelId: "m1" });

    expect(db.prepare("SELECT provider_id, model_id FROM project WHERE id=?").get(project.id))
      .toMatchObject({ provider_id: "pv1", model_id: "m1" });

    // Not naming them keeps them: the language can be corrected without
    // silently unconfiguring the book.
    await handlers["project.update"]({ id: project.id, description: "x" });
    expect(db.prepare("SELECT provider_id, model_id FROM project WHERE id=?").get(project.id))
      .toMatchObject({ provider_id: "pv1", model_id: "m1" });
  });

  it("refuses a project that is not there", async () => {
    const { deps: d } = await deps();
    await expect(buildHandlers(d)["project.update"]({ id: "ghost", targetLanguage: "fr" }))
      .rejects.toThrow();
  });
});

/**
 * The provider channels, and the one property that matters more than the rest.
 *
 * A provider is worth nothing to the user until it can be added without a
 * database client, so these channels exist. But every one of them handles a
 * credential, and the renderer is the one place it must never reach: an
 * `IpcFailure`, a devtools panel and a crash dump all serialise whatever
 * crossed the bridge. So the key tests are not about CRUD, they are about
 * what the replies do *not* contain.
 */
describe("the provider channels", () => {
  const secret = "sk-not-in-any-reply";

  async function withProvider(apiKey: string | null = secret) {
    const { deps: d } = await deps();
    const handlers = buildHandlers(d);
    const created = await handlers["provider.create"]({
      name: "Acme", route: "openai-compatible", baseUrl: "https://api.acme.test/v1",
      headers: {}, options: {}, catalogId: null, catalogAt: null,
      models: [{ id: "m1", displayName: "M1", contextWindow: 128_000, priceIn: 1, priceOut: 5,
        capabilities: null }],
      ...(apiKey === null ? {} : { apiKey }),
    });
    return { deps: d, handlers, created };
  }

  it("creates a provider and says it has a key, without ever saying the key", async () => {
    const { handlers, created } = await withProvider();

    expect(created).toMatchObject({ name: "Acme", route: "openai-compatible", hasKey: true });
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(JSON.stringify(await handlers["providers.list"](undefined))).not.toContain(secret);
  });

  it("stores the key sealed, so the database is not a place to read it", async () => {
    const { deps: d, created } = await withProvider();
    const row = d.db.prepare("SELECT api_key_encrypted FROM provider WHERE id=?")
      .get(created.id) as { api_key_encrypted: Uint8Array };

    // node:sqlite yields a BLOB as a Uint8Array, whose own toString would
    // render "115,107,45,…" and match nothing: it has to go through a Buffer
    // or the assertion cannot fail.
    expect(Buffer.from(row.api_key_encrypted).toString("utf8")).not.toContain(secret);
  });

  it("keeps the key when an edit does not mention it", async () => {
    const { deps: d, handlers, created } = await withProvider();
    const updated = await handlers["provider.update"]({ id: created.id, name: "Acme Europe" });

    // The renderer cannot send back a key it is not allowed to see, so an
    // absent one has to mean "leave it": otherwise renaming a provider would
    // silently log the user out of it.
    expect(updated).toMatchObject({ name: "Acme Europe", hasKey: true });
    expect(readKey(d.db, testCrypto, created.id)).toBe(secret);
  });

  it("clears the key only when the request says so on purpose", async () => {
    const { deps: d, handlers, created } = await withProvider();
    const updated = await handlers["provider.update"]({ id: created.id, apiKey: null });

    expect(updated.hasKey).toBe(false);
    expect(readKey(d.db, testCrypto, created.id)).toBeNull();
  });

  it("replaces the models a provider serves", async () => {
    const { handlers, created } = await withProvider();
    const updated = await handlers["provider.update"]({
      id: created.id,
      models: [{ id: "m2", displayName: "M2", contextWindow: null, priceIn: null, priceOut: null,
        capabilities: null }],
    });

    expect(updated.models.map((model) => model.id)).toEqual(["m2"]);
  });

  it("accepts a provider with no key, because a local endpoint needs none", async () => {
    const { created } = await withProvider(null);
    expect(created.hasKey).toBe(false);
  });

  it("deletes a provider, and says so when there was none to delete", async () => {
    const { handlers, created } = await withProvider();

    await handlers["provider.delete"]({ id: created.id });
    expect(await handlers["providers.list"](undefined)).toEqual([]);
    await expect(handlers["provider.delete"]({ id: "ghost" })).rejects.toThrow();
  });

  it("offers the presets as starting values, keys excluded by construction", async () => {
    const { deps: d } = await deps();
    const presets = await buildHandlers(d)["providers.presets"](undefined);

    // The one hand-built case left: the shortcut for what the catalogue does
    // not know. Named providers are chosen from the catalogue instead.
    expect(presets.map((preset) => preset.route)).toEqual(["openai-compatible"]);
    expect(presets.every((preset) => !("apiKey" in preset))).toBe(true);
  });

  it("refuses an edit of a provider that is not there", async () => {
    const { deps: d } = await deps();
    await expect(buildHandlers(d)["provider.update"]({ id: "ghost", name: "X" })).rejects.toThrow();
  });
});

describe("handing a file to the desktop", () => {
  async function withProject() {
    const { dir, db, deps: d } = await deps();
    const opened: string[] = [];
    const revealed: string[] = [];
    db.prepare(`
      INSERT INTO project (id, filename, title, workspace_path, source_sha256, created_at,
                           target_language, state)
      VALUES ('p1','a.epub','A',?,'h','2026-08-24','it','done')
    `).run(`${dir}/projects/p1`);

    return {
      dir,
      opened,
      revealed,
      handlers: buildHandlers({
        ...d,
        openPath: async (path: string) => { opened.push(path); },
        revealPath: async (path: string) => { revealed.push(path); },
      }),
    };
  }

  it("opens a file the application itself produced", async () => {
    const { dir, opened, handlers } = await withProject();
    const produced = `${dir}/projects/p1/output/a.it.epub`;

    await handlers["file.open"]({ path: produced });
    await handlers["file.reveal"]({ path: produced });

    expect(opened).toEqual([produced]);
  });

  // Production break: the window can name any path and the desktop obeys.
  it("refuses a path outside every workspace, and does not call the desktop", async () => {
    const { opened, revealed, handlers } = await withProject();

    await expect(handlers["file.open"]({ path: "/etc/passwd" }))
      .rejects.toThrow(/PATH_NOT_PRODUCED/);
    await expect(handlers["file.reveal"]({ path: "/home/someone/.ssh/id_rsa" }))
      .rejects.toThrow(/PATH_NOT_PRODUCED/);

    expect(opened).toEqual([]);
    expect(revealed).toEqual([]);
  });

  it("refuses a workspace path built by prefix, not by containment", async () => {
    const { dir, opened, handlers } = await withProject();

    // `<workspace>-evil/x` starts with the workspace path as a string but is
    // not inside it; requiring the separator is what tells them apart.
    await expect(handlers["file.open"]({ path: `${dir}/projects/p1-evil/x.epub` }))
      .rejects.toThrow(/PATH_NOT_PRODUCED/);
    expect(opened).toEqual([]);
  });
});

describe("importing and exporting a glossary", () => {
  const markdown = `---
name: fantasy
version: 1
description: Epic fantasy
sourceLanguage: en
targetLanguage: it
---

| source | target | rule |
|---|---|---|
| Rivendell |  | dnt |
`;

  async function withFiles(chosen: { open?: string | null; save?: string | null } = {}) {
    const { dir, db, deps: d } = await deps();
    const asked: string[] = [];
    const handlers = buildHandlers({
      ...d,
      chooseOpen: async (kind: string) => {
        asked.push(kind);
        return chosen.open ?? null;
      },
      chooseSave: async () => chosen.save ?? null,
    });
    return { dir, db, asked, handlers };
  }

  it("reads the chosen file in the main process and stores what it parsed", async () => {
    const { dir } = await withFiles();
    const source = join(dir, "fantasy.md");
    await writeFile(source, markdown);

    const { db, asked, handlers } = await withFiles({ open: source });
    const imported = await handlers["glossary.importFile"](undefined);

    // The renderer never reads a file: it asks, and the main process answers
    // with what it parsed.
    expect(imported).toMatchObject({ name: "fantasy", version: 1 });
    expect(asked).toEqual(["glossary"]);
    expect(db.prepare("SELECT count(*) AS n FROM glossary").get()).toMatchObject({ n: 1 });
  });

  it("answers null when the dialog was dismissed, and imports nothing", async () => {
    const { db, asked, handlers } = await withFiles({ open: null });

    expect(await handlers["glossary.importFile"](undefined)).toBeNull();
    expect(asked).toEqual(["glossary"]);
    expect(db.prepare("SELECT count(*) AS n FROM glossary").get()).toMatchObject({ n: 0 });
  });

  it("writes the export where the dialog said, in the format the parser reads", async () => {
    const { dir } = await withFiles();
    const out = join(dir, "out.md");
    const { handlers } = await withFiles({ save: out });
    const glossary = await handlers["glossary.import"]({ markdown });

    expect(await handlers["glossary.exportFile"]({ id: glossary.id })).toMatchObject({ path: out });
    expect(await readFile(out, "utf8")).toContain("name: fantasy");
  });

  it("writes nothing when the save dialog was dismissed", async () => {
    const { handlers } = await withFiles({ save: null });
    const glossary = await handlers["glossary.import"]({ markdown });

    expect(await handlers["glossary.exportFile"]({ id: glossary.id })).toBeNull();
  });

  it("refuses to ask where to save a glossary it cannot serialise", async () => {
    const { asked, handlers } = await withFiles({ save: "/tmp/never.md" });

    // The dialog must not open for a glossary that is not there: asking the
    // user where to put nothing is worse than saying it is missing.
    await expect(handlers["glossary.exportFile"]({ id: "ghost" }))
      .rejects.toThrow(/GLOSSARY_UNKNOWN/);
    expect(asked).toEqual([]);
  });

  it("asks for a jar when the settings want one, and stores the path", async () => {
    const { asked, handlers } = await withFiles({ open: "/opt/epubcheck.jar" });

    expect(await handlers["settings.chooseJar"](undefined))
      .toMatchObject({ epubcheckJar: "/opt/epubcheck.jar" });
    expect(asked).toEqual(["jar"]);
    expect((await handlers["settings.get"](undefined)).epubcheckJar).toBe("/opt/epubcheck.jar");
  });

  it("leaves the settings alone when no jar was chosen", async () => {
    const { handlers } = await withFiles({ open: null });

    expect((await handlers["settings.chooseJar"](undefined)).epubcheckJar).toBeNull();
  });
});

describe("clearing a setting", () => {
  // Production break: `String(null)` stores the four letters "null", and the
  // jar path comes back as a path that cannot exist.
  it("removes a setting asked to be null instead of storing the word", async () => {
    const { deps: d } = await deps();
    const handlers = buildHandlers(d);

    await handlers["settings.set"]({ epubcheckJar: "/opt/epubcheck.jar" });
    const cleared = await handlers["settings.set"]({ epubcheckJar: null });

    expect(cleared.epubcheckJar).toBeNull();
    expect((await handlers["settings.get"](undefined)).epubcheckJar).toBeNull();
  });
});
