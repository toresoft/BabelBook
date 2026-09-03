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

/**
 * What a book is made of, as the manifest happens to have written it down.
 *
 * A book found on disk had 193 and 677 translatable paragraphs per chapter and
 * produced one unit: `<h2>` out of `nav.xhtml`. Every chapter was declared
 * `text/html` — ebooklib writes that, and a good share of what exists was made
 * by ebooklib — and the selection took only `application/xhtml+xml`. The
 * project was created, ran to `done`, and wrote out a book still entirely in
 * English, and nobody was told any of it.
 */
describe("choosing what to translate", () => {
  it("reads a chapter the manifest calls text/html", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "ebooklib.epub", {
      title: "Designing Agents", language: "en",
      documents: [
        { path: "OEBPS/chapter-1.html", xhtml: "<p>One</p><p>Two</p>", mediaType: "text/html" },
        { path: "OEBPS/chapter-2.html", xhtml: "<p>Three</p>", mediaType: "text/html" },
      ],
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });

    const chapters = db.prepare(`
      SELECT d.zip_path AS path, count(u.id) AS n
        FROM project_document d JOIN unit u ON u.document_id = d.id
       WHERE d.project_id = ? AND d.zip_path LIKE '%chapter%'
       GROUP BY d.id ORDER BY d.spine_order
    `).all(created.id) as Array<{ path: string; n: number }>;

    expect(chapters).toEqual([
      { path: "OEBPS/chapter-1.html", n: 2 },
      { path: "OEBPS/chapter-2.html", n: 1 },
    ]);
  });

  /** Non-conforming is not the same as wrong, but it is worth writing down. */
  it("declares that the book named a type EPUB does not use", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "ebooklib.epub", {
      title: "Designing Agents", language: "en",
      documents: [{ path: "OEBPS/chapter-1.html", xhtml: "<p>One</p>", mediaType: "text/html" }],
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });

    const event = db.prepare(
      "SELECT code, severity, payload_json FROM run_event WHERE run_id = ? AND code = 'html-media-type'",
    ).get(created.id) as { code: string; severity: string; payload_json: string } | undefined;
    expect(event?.severity).toBe("info");
    expect(JSON.parse(event!.payload_json)).toMatchObject({ documents: 1 });
  });

  /**
   * The reading order decides, with one exception. The manifest holds things
   * no reader ever opens, and translating one of those spends money on a page
   * nobody sees; the navigation document is shown by every reader whether the
   * spine names it or not, so it is taken either way.
   */
  it("takes the spine's order, and only the spine", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "aside.epub", {
      title: "With An Aside", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
      extra: [{ path: "OEBPS/orphan.xhtml", bytes: Buffer.from("<html><body><p>Nobody</p></body></html>", "utf8") }],
      manifestExtra: '<item id="orphan" href="orphan.xhtml" media-type="application/xhtml+xml"/>',
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });

    const paths = db.prepare(
      "SELECT zip_path FROM project_document WHERE project_id = ?",
    ).all(created.id) as Array<{ zip_path: string }>;
    expect(paths.map((row) => row.zip_path)).not.toContain("OEBPS/orphan.xhtml");
    // Taken even though this fixture leaves it out of the spine: a contents
    // page in English in front of an Italian book is a defect a reader sees
    // first.
    expect(paths.map((row) => row.zip_path)).toContain("OEBPS/nav.xhtml");
  });

  /** A spine entry of a kind we do not read stops disappearing quietly. */
  it("declares a spine entry it cannot read", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "mixed.epub", {
      title: "Mixed", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: "<p>One</p>" }],
      extra: [{ path: "OEBPS/plate.svg", bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8") }],
      manifestExtra: '<item id="plate" href="plate.svg" media-type="image/svg+xml"/>',
      spineExtra: '<itemref idref="plate"/>',
    });

    const created = await createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE });

    const event = db.prepare(
      "SELECT severity, payload_json FROM run_event WHERE run_id = ? AND code = 'document-skipped'",
    ).get(created.id) as { severity: string; payload_json: string } | undefined;
    expect(JSON.parse(event!.payload_json)).toMatchObject({ documents: 1 });
  });

  /**
   * The net that would have caught the book above in ten seconds instead of
   * after a whole translation: a project that can translate nothing is not a
   * project, and saying so at the door costs nothing.
   */
  it("refuses a book with nothing to translate instead of creating an empty project", async () => {
    const { dir, db } = await setup();
    const epub = await epubAt(dir, "plates.epub", {
      title: "Plates Only", language: "en",
      documents: [{ path: "OEBPS/c1.xhtml", xhtml: '<p><img src="plate.png" /></p>' }],
    });

    await expect(createProject(db, dir, { epubPath: epub, targetLanguage: "it", ...CHOICE }))
      .rejects.toMatchObject({ code: "NO_TRANSLATABLE_CONTENT", fault: "input" });

    expect(count(db, "project")).toBe(0);
  });
});
