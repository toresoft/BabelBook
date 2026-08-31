import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { loadCatalogue } from "../main/catalogue.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { buildHandlers, type ConfirmQuestion, type IpcDeps } from "../main/ipc.ts";

// A keyring that actually hides what it is given, so the assertions that use
// it cannot pass while storing something readable.
const crypto = {
  isAvailable: () => true,
  encrypt: (plain: string) =>
    Buffer.from(Buffer.from(`enc:${plain}`, "utf8").toString("base64"), "utf8"),
  decrypt: (blob: Buffer) =>
    Buffer.from(blob.toString("utf8"), "base64").toString("utf8").replace(/^enc:/, ""),
};

/**
 * The question a destructive act is asked before it happens.
 *
 * Four things destroy work without a screen of their own — abandoning a
 * project just analysed, deleting a project, a provider, a glossary — and the
 * question they are asked is assembled here, in the main process, from the
 * catalogue. The dialog itself is injected like every dialog: the words are
 * ours, the pixels belong to the platform.
 */

interface Scene {
  db: ReturnType<typeof openDatabase>;
  deps: IpcDeps;
  /** Every question the fake dialog was asked, in order. */
  questions: ConfirmQuestion[];
}

async function scene(answer: boolean, overrides: Partial<IpcDeps> = {}): Promise<Scene> {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-confirm-"));
  const db = openDatabase(":memory:");
  migrate(db, loadMigrations("app/main/db/migrations"));
  db.prepare(`
    INSERT INTO provider (id, name, route, headers, options)
    VALUES ('pv1', 'Acme', 'openai-compatible', '{}', '{}')
  `).run();
  db.prepare(`
    INSERT INTO provider_model (id, provider_id, model_id, display_name)
    VALUES ('pm1', 'pv1', 'm1', 'M1')
  `).run();
  const t = await loadCatalogue("it", "app/locales");
  const questions: ConfirmQuestion[] = [];

  const deps = {
    db,
    userDataDir: dir,
    crypto,
    t,
    chooseEpub: async () => null,
    askConfirm: async (question: ConfirmQuestion) => {
      questions.push(question);
      return answer;
    },
    broadcast: () => {},
    ...overrides,
  } as unknown as IpcDeps;

  return { db, deps, questions };
}

/** A real project, through the real channel, so the counts count something. */
async function aProject(deps: IpcDeps, dir: string, title: string): Promise<string> {
  const epub = join(dir, `${title}.epub`);
  await writeFile(epub, await buildEpub({ title, documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }] }));
  const created = await buildHandlers(deps)["project.create"]({
    epubPath: epub, targetLanguage: "it", providerId: "pv1", modelId: "m1",
  });
  return created.id;
}

describe("ui.confirm", () => {
  it("asks before every destructive act, with a verb that names it — never OK", async () => {
    const cases = [
      { kind: "deleteProject", detail: { title: "Il Nome della Rosa" }, named: "Il Nome della Rosa" },
      { kind: "abandonProject", detail: { title: "Il Nome della Rosa" }, named: "Il Nome della Rosa" },
      { kind: "deleteProvider", detail: { name: "OpenRouter" }, named: "OpenRouter" },
      { kind: "deleteGlossary", detail: { id: "none", name: "fantasy" }, named: "fantasy" },
    ] as const;

    for (const one of cases) {
      const { deps, questions } = await scene(true);
      const answer = await buildHandlers(deps)["ui.confirm"]({ kind: one.kind, detail: { ...one.detail } });

      expect(answer).toEqual({ confirmed: true });
      expect(questions).toHaveLength(1);
      // The question names the thing it is about to destroy, and the way in
      // carries a verb: a "OK" would make every deletion the same word.
      expect(questions[0]!.message).toContain(one.named);
      expect(questions[0]!.verify).not.toBe("OK");
      expect(questions[0]!.verify.length).toBeGreaterThan(0);
      expect(questions[0]!.verify).not.toBe(questions[0]!.cancel);
    }
  });

  it("disconnects a provider rather than deleting it, and says what goes with it", async () => {
    const { deps, questions } = await scene(true);

    await buildHandlers(deps)["ui.confirm"]({ kind: "deleteProvider", detail: { name: "OpenRouter" } });

    // The act is undoing a connection, not destroying a thing that was made
    // here: the verb has to match, or the question describes something else.
    expect(questions[0]!.verify).toBe("Disconnetti");
    expect(questions[0]!.message).toContain("OpenRouter");
  });

  it("answers no, and touches nothing when it does", async () => {
    const { db, deps } = await scene(false);
    const handlers = buildHandlers(deps);
    const id = await aProject(deps, deps.userDataDir, "Kept");
    const broadcast = vi.fn();
    const watched = buildHandlers({ ...deps, broadcast });

    const answer = await watched["ui.confirm"]({ kind: "deleteProject", detail: { title: "Kept" } });

    expect(answer).toEqual({ confirmed: false });
    // A refusal is only an answer: the project, the provider, the glossary
    // are whoever's they were. Nothing in the database moved.
    expect((db.prepare("SELECT count(*) AS n FROM project").get() as { n: number }).n).toBe(1);
    expect(await handlers["project.get"]({ id }) === null).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("counts the projects before the glossary goes, and says so in the question", async () => {
    const { deps, questions } = await scene(true);
    const handlers = buildHandlers(deps);
    const glossary = await handlers["glossary.save"]({
      id: "g1", name: "fantasy", version: 1, description: "Names", sourceLanguage: "en",
      targetLanguage: "it", terms: [],
    });
    const one = await aProject(deps, deps.userDataDir, "One");
    const two = await aProject(deps, deps.userDataDir, "Two");
    await handlers["glossary.attach"]({ projectId: one, glossaryId: glossary.id, attached: true });
    await handlers["glossary.attach"]({ projectId: two, glossaryId: glossary.id, attached: true });

    await handlers["ui.confirm"]({ kind: "deleteGlossary", detail: { id: glossary.id, name: "fantasy" } });

    // The count is read before anything is destroyed — afterwards there is
    // nothing left to count — and it stands in the question, where it can
    // still change the answer.
    expect(questions[0]!.message).toContain("2");
  });

  it("says plainly when a glossary is attached to no project", async () => {
    const { deps, questions } = await scene(true);
    const handlers = buildHandlers(deps);
    const glossary = await handlers["glossary.save"]({
      id: "g1", name: "fantasy", version: 1, description: "Names", sourceLanguage: "en",
      targetLanguage: "it", terms: [],
    });

    await handlers["ui.confirm"]({ kind: "deleteGlossary", detail: { id: glossary.id, name: "fantasy" } });

    expect(questions[0]!.message).not.toContain("{{count}}");
    expect(questions[0]!.message).not.toMatch(/\b0\b/);
  });

  it("counts one project in the singular, which is the commonest case of all", async () => {
    const { deps, questions } = await scene(true);
    const handlers = buildHandlers(deps);
    const glossary = await handlers["glossary.save"]({
      id: "g1", name: "fantasy", version: 1, description: "Names", sourceLanguage: "en",
      targetLanguage: "it", terms: [],
    });
    const one = await aProject(deps, deps.userDataDir, "One");
    await handlers["glossary.attach"]({ projectId: one, glossaryId: glossary.id, attached: true });

    await handlers["ui.confirm"]({ kind: "deleteGlossary", detail: { id: glossary.id, name: "fantasy" } });

    // "1 progetti" is the sentence a plural-only string writes, and a glossary
    // used by a single project is the likeliest thing anyone deletes.
    expect(questions[0]!.message).not.toMatch(/\bprogetti\b/);
  });

  it("keeps the cancel as what Return and Escape answer", async () => {
    const { deps, questions } = await scene(true);
    await buildHandlers(deps)["ui.confirm"]({ kind: "deleteProvider", detail: { name: "OpenRouter" } });

    // The contract is the order: the way out first, so the key that is
    // easiest to hit — Return, Escape — is never the one that destroys.
    // The real dialog pins both keys to index 0; this holds it to that.
    expect(questions[0]!.cancel.length).toBeGreaterThan(0);
    const source = await readFile("app/main/main.ts", "utf8");
    expect(source).toContain("defaultId: 0");
    expect(source).toContain("cancelId: 0");
  });

  it("asks on the window, so the question cannot be lost behind it", async () => {
    const source = await readFile("app/main/main.ts", "utf8");
    const body = /askConfirm: async \(question\) => \{([\s\S]*?)\n    \},/.exec(source);

    // An un-parented box is not modal: on Linux and Windows a click on the
    // main window drops it behind, and the renderer waits on `ui.confirm`
    // for ever — a Delete that neither deletes nor fails.
    expect(body).not.toBeNull();
    expect(body?.[1]).toContain("showMessageBox(glue.window,");
  });
});
