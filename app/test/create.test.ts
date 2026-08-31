import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildEpub } from "../../core/test/corpus/build.ts";
import { loadMigrations, migrate, openDatabase } from "../main/db/open.ts";
import { createProject } from "../main/projects/create.ts";
import { statesOf } from "../main/run/states.ts";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "babelbook-create-"));
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
  return { dir, db };
}

/** A provider and a model that exist, because from now on a project needs both. */
const CHOICE = { providerId: "pv1", modelId: "m1" } as const;

async function epubAt(dir: string, name: string, spec: Parameters<typeof buildEpub>[0]) {
  const path = join(dir, name);
  await writeFile(path, await buildEpub(spec));
  return path;
}

const count = (db: ReturnType<typeof openDatabase>, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("createProject", () => {
  it("stores the project, its documents and its units", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      title: "The Book", language: "en",
      documents: [
        { path: "OEBPS/c1.xhtml", xhtml: "<p>One</p><pre>x = 1</pre>" },
        { path: "OEBPS/c2.xhtml", xhtml: "<p>Two</p>" },
      ],
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });

    expect(created.title).toBe("The Book");
    expect(created.declaredLanguage).toBe("en");
    expect(created.units.byState.code).toBe(1);
    expect(count(db, "unit")).toBe(created.units.total);
    expect(count(db, "project_document")).toBe(created.documents);
  });

  it("writes the analysis down as a phase that happened, with what it found", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      title: "The Book", language: "en",
      documents: [
        { path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" },
        { path: "OEBPS/c2.xhtml", xhtml: "<p>Two</p>" },
      ],
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });

    const phases = statesOf(db, created.id).filter((state) => state.kind === "phase");
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ name: "analyze", outcome: "done" });
    // The corpus builder adds its navigation document beside the two chapters.
    expect(phases[0]!.info).toMatchObject({ documents: 3 });
    expect(phases[0]!.leftAt).not.toBeNull();
  });

  it("measures analysis from before the book is read, not after it is finished", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-30T09:00:00.000Z"));
      const creating = createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });
      vi.setSystemTime(new Date("2026-08-30T09:02:00.000Z"));

      const created = await creating;
      const analysis = statesOf(db, created.id).find(
        (state) => state.kind === "phase" && state.name === "analyze",
      );
      expect(analysis?.enteredAt).toBe("2026-08-30T09:00:00.000Z");
      expect(analysis?.leftAt).toBe("2026-08-30T09:02:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the bytes of each unit apart from its decoded text", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>a &#38; b</p>" }],
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });
    const row = db.prepare(
      "SELECT source_text, raw_text FROM unit WHERE project_id = ? AND source_text LIKE '%&%'",
    ).get(created.id) as { source_text: string; raw_text: string };

    expect(row).toMatchObject({ source_text: "a & b", raw_text: "a &#38; b" });
  });

  it("refuses a file that is not an EPUB, naming the format", async () => {
    const { dir, db } = await setup();
    const notEpub = join(dir, "book.mobi");
    await writeFile(notEpub, "BOOKMOBI and then some rubbish");

    await expect(createProject(db, dir, { epubPath: notEpub, targetLanguage: "it", ...CHOICE }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", format: "MOBI" });
  });

  it("refuses a zip that is not an EPUB either", async () => {
    const { dir, db } = await setup();
    const zip = join(dir, "notes.zip");
    await writeFile(zip, Buffer.from("504b0304000000000000", "hex"));

    await expect(createProject(db, dir, { epubPath: zip, targetLanguage: "it", ...CHOICE }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });

  it("reports fixed layout instead of silently translating it", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "comic.epub", {
      documents: [{ path: "OEBPS/p1.xhtml", xhtml: "<p>Plate</p>", layout: "pre-paginated" }],
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });

    expect(created.layout.prePaginated).toBeGreaterThan(0);
    const row = db.prepare("SELECT layout FROM project WHERE id = ?").get(created.id) as { layout: string };
    expect(["pre-paginated", "mixed"]).toContain(row.layout);
  });

  it("reports media overlays at creation, before anything is spent", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "audio.epub", {
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: `<p id="p1">Hi</p>` }],
      overlays: [{
        smilPath: "OEBPS/c1.smil", audioPath: "OEBPS/c1.mp3",
        forDocument: "OEBPS/c1.xhtml", duration: "0:00:05",
      }],
    });

    expect((await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE })).hasOverlays)
      .toBe(true);
  });

  it("leaves nothing behind when ingestion fails halfway", async () => {
    const { dir, db } = await setup();
    const broken = join(dir, "broken.epub");
    await writeFile(broken, Buffer.concat([
      Buffer.from("504b0304", "hex"), Buffer.from("mimetypeapplication/epub+zip"),
      Buffer.from("then nothing that is a zip"),
    ]));

    await expect(createProject(db, dir, { epubPath: broken, targetLanguage: "it", ...CHOICE })).rejects.toThrow();

    expect(count(db, "project")).toBe(0);
    expect(count(db, "unit")).toBe(0);
    // The shared `projects/` folder stays — other projects live in it. What
    // must be gone is this project's own workspace.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dir, "projects")).catch(() => [])).toEqual([]);
  });

  it("does not call any model to create a project", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });
    expect(created.id).toBeTruthy();
  });

  it("counts the words of the work, which is what a cost estimate is built on", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>one two three</p><pre>x = 1</pre>" }],
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });
    expect(created.words).toBeGreaterThanOrEqual(3);
  });

  it("waits for the language when the package does not declare one", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      language: "und", documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });
    const row = db.prepare("SELECT state FROM project WHERE id = ?").get(created.id) as { state: string };

    expect(created.declaredLanguage).toBeNull();
    expect(row.state).toBe("needs-language");
  });

  it("copies the book and extracts its cover into the workspace", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
      extra: [{ path: "OEBPS/cover.png", bytes: Buffer.from("89504e470d0a1a0a", "hex") }],
      manifestExtra: `<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>`,
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });

    expect(created.coverPath).not.toBeNull();
    expect(existsSync(created.coverPath!)).toBe(true);
    expect(existsSync(join(dir, "projects", created.id, "source.epub"))).toBe(true);
  });

  it("refuses a project with no provider, and leaves nothing behind on the disk", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      title: "The Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    });

    await expect(createProject(db, dir, {
      epubPath: epub, targetLanguage: "it", providerId: "", modelId: "",
    })).rejects.toMatchObject({ code: "PROVIDER_REQUIRED" });

    expect(count(db, "project")).toBe(0);
    // The refusal has to come before the workspace: an EPUB copied for a
    // project that was then refused is the half-ingestion this file exists
    // not to leave behind.
    expect(existsSync(join(dir, "projects"))).toBe(false);
  });

  it("refuses a provider that does not exist, and a model that is not its", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      title: "The Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    });

    await expect(createProject(db, dir, {
      epubPath: epub, targetLanguage: "it", providerId: "nope", modelId: "m1",
    })).rejects.toMatchObject({ code: "UNKNOWN_PROVIDER" });

    await expect(createProject(db, dir, {
      epubPath: epub, targetLanguage: "it", providerId: "pv1", modelId: "nope",
    })).rejects.toMatchObject({ code: "UNKNOWN_MODEL" });
  });

  it("writes the chosen provider and model onto the row", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "book.epub", {
      title: "The Book", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
    });

    const created = await createProject(db, dir, {
      epubPath: epub, targetLanguage: "it", ...CHOICE,
    });

    expect(db.prepare("SELECT provider_id AS p, model_id AS m FROM project WHERE id = ?")
      .get(created.id)).toEqual({ p: "pv1", m: "m1" });
  });
});
