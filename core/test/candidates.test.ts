import { describe, expect, it } from "vitest";
import { extractCandidates } from "../analyze/candidates.ts";
import { FakeBackend } from "./fake/backend.ts";
import type { TranslationUnit } from "../epub/index.ts";

const units: TranslationUnit[] = Array.from({ length: 60 }, (_, i) => {
  const source = i % 2 === 0
    ? "Frodo walked to Rivendell at dawn"
    : "The dwarf sharpened his axe";
  return {
    id: `c1.xhtml#${i + 1}`, kind: "block" as const, doc: "c1.xhtml", ordinal: i + 1,
    range: [i * 40, i * 40 + source.length], source, raw: source, state: "translate" as const,
  };
});

const answer = `TERMS 2
[t:Rivendell] rule=dnt note=place name
[t:dwarf] rule=must target=nano
END`;

const thrice = (text: string) => new FakeBackend([text, text, text]);

describe("extractCandidates", () => {
  it("reads the candidates and attaches the sentence they came from", async () => {
    const report = await extractCandidates({
      units, backend: thrice(answer), sourceLanguage: "en", targetLanguage: "it",
    });

    const rivendell = report.candidates.find((c) => c.source === "Rivendell")!;
    expect(rivendell).toMatchObject({ rule: "dnt", origin: "extracted", approval: "pending" });
    expect(rivendell.context).toContain("Rivendell");
    expect(rivendell.occurrences).toBeGreaterThan(1);
  });

  it("counts occurrences in the book, not in the answer", async () => {
    const report = await extractCandidates({
      units, backend: thrice(answer), sourceLanguage: "en", targetLanguage: "it",
    });
    expect(report.candidates.find((c) => c.source === "Rivendell")!.occurrences).toBe(30);
  });

  it("proposes a term once, however many samples turned it up", async () => {
    const report = await extractCandidates({
      units, backend: thrice(answer), sourceLanguage: "en", targetLanguage: "it",
    });
    expect(report.candidates.filter((c) => c.source === "dwarf")).toHaveLength(1);
  });

  it("puts the user's description in the prompt", async () => {
    const backend = thrice(answer);
    await extractCandidates({
      units, backend, sourceLanguage: "en", targetLanguage: "it",
      description: "Second volume of a trilogy; Frodo is a hobbit, not a person",
    });
    expect(backend.prompts[0]).toContain("Second volume of a trilogy");
  });

  it("everything starts pending: nothing is approved by being proposed", async () => {
    const report = await extractCandidates({
      units, backend: thrice(answer), sourceLanguage: "en", targetLanguage: "it",
    });
    expect(report.candidates.every((c) => c.approval === "pending")).toBe(true);
  });

  it("abstains instead of guessing when nothing came back in the format", async () => {
    const report = await extractCandidates({
      units, sourceLanguage: "en", targetLanguage: "it",
      backend: thrice("I think the main terms are Rivendell and dwarf."),
    });
    expect(report).toMatchObject({ abstained: true, candidates: [] });
  });

  it("keeps what one good sample gave, even when another was malformed", async () => {
    const report = await extractCandidates({
      units, sourceLanguage: "en", targetLanguage: "it",
      backend: new FakeBackend(["sorry, no idea", answer, answer]),
    });
    expect(report.abstained).toBe(false);
    expect(report.candidates.map((c) => c.source).sort()).toEqual(["Rivendell", "dwarf"]);
  });

  it("carries a term the model could not decide into the open questions", async () => {
    const withOpen = `TERMS 1
[t:Rivendell] rule=dnt note=place name
OPEN 1
[o:dwarf] a species or a surname here?
END`;
    const report = await extractCandidates({
      units, backend: thrice(withOpen), sourceLanguage: "en", targetLanguage: "it",
    });
    expect(report.open).toEqual([{ source: "dwarf", question: "a species or a surname here?" }]);
  });

  it("opens a question when the samples disagree on the same term", async () => {
    const asMust = `TERMS 1\n[t:Rivendell] rule=must target=Forravalle\nEND`;
    const asDnt = `TERMS 1\n[t:Rivendell] rule=dnt note=place name\nEND`;
    const report = await extractCandidates({
      units, sourceLanguage: "en", targetLanguage: "it",
      backend: new FakeBackend([asMust, asDnt, asDnt]),
    });

    expect(report.candidates.find((c) => c.source === "Rivendell")).toBeUndefined();
    expect(report.open[0].source).toBe("Rivendell");
  });

  it("discards a term the book does not contain, and says how many", async () => {
    const invented = `TERMS 1\n[t:Numenor] rule=dnt note=place name\nEND`;
    const report = await extractCandidates({
      units, backend: thrice(invented), sourceLanguage: "en", targetLanguage: "it",
    });

    expect(report.candidates).toEqual([]);
    expect(report.discarded).toBe(1);
  });

  it("refuses a must rule with nothing to render it as", async () => {
    const bad = `TERMS 1\n[t:dwarf] rule=must\nEND`;
    const report = await extractCandidates({
      units, backend: thrice(bad), sourceLanguage: "en", targetLanguage: "it",
    });
    expect(report).toMatchObject({ abstained: true, candidates: [] });
  });

  it("stops on an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(extractCandidates({
      units, backend: thrice(answer), sourceLanguage: "en", targetLanguage: "it",
      signal: controller.signal,
    })).rejects.toThrow();
  });
});
