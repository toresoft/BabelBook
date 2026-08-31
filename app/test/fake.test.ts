import { describe, expect, it } from "vitest";
import { indexCodeBlocks } from "../../core/analyze/code.ts";
import { extractCandidates } from "../../core/analyze/candidates.ts";
import { buildPayload, parseResponse } from "../../core/translate/wire.ts";
import type { TranslationUnit } from "../../core/epub/index.ts";
import { fakeBackend, FAKE_MARKER } from "../engine/fake.ts";

/**
 * The deterministic backend, held against the questions the run actually asks.
 *
 * Nothing tested this file until a wire format changed underneath it. The
 * code-index question was rewritten to `#CODEINDEX`/`#CODEVERDICT`; the fake
 * went on answering the `VERDICTS` shape that had been replaced, so its answer
 * matched no branch, fell through to the sampling sentence, and every batch
 * abstained. An abstention is a degradation, a degradation ends a book
 * `incomplete` rather than `done`, and four end-to-end tests failed three
 * minutes at a time saying so.
 *
 * So these cases never speak the wire themselves. Each one asks through the
 * function the run uses, so the day a prompt changes shape this file goes red
 * in two seconds instead of the suite going red in three minutes — and for a
 * reason that names the fake instead of naming the book.
 */

const unit = (
  n: number, source: string, state: TranslationUnit["state"] = "translate",
): TranslationUnit => ({
  id: `c1.xhtml#${n}`, kind: "block", doc: "c1.xhtml", ordinal: n,
  range: [n, n + source.length], source, raw: source, state,
});

describe("the deterministic backend", () => {
  it("answers the code-index question in the format the run reads back", async () => {
    const index = await indexCodeBlocks({
      units: [unit(1, "The road to Rivendell"), unit(2, "npm install foo")],
      sourceHash: "h1",
      backend: fakeBackend(),
    });

    // Not one batch left undecided. This is the whole assertion: an abstention
    // is what a malformed answer becomes, and it is invisible until a project
    // that translated everything still refuses to say it is done.
    expect(index.abstained).toBe(0);

    // And it decides rather than shrugging: everything is prose, so nothing is
    // marked and nothing is freed. A fake that invented code would make the
    // exclusions gate of the end-to-end tests depend on its taste.
    expect(index.marked).toEqual([]);
    expect(index.freed).toEqual([]);
  });

  it("answers the translation question with the units it was given", async () => {
    const units = [unit(1, "One"), unit(2, "Two")];
    const payload = buildPayload({
      units,
      terms: [],
      context: {
        sourceLanguage: "en", targetLanguage: "it",
        before: [], after: [], interleaved: [],
        chapter: { doc: "c1.xhtml", position: 1, total: 1 },
      },
    });

    const parsed = parseResponse((await fakeBackend().call({ prompt: payload })).text);

    expect(parsed.terminated).toBe(true);
    expect(parsed.declared).toBe(2);
    expect(parsed.lines.map((line) => line.unitId)).toEqual(["c1.xhtml#1", "c1.xhtml#2"]);
    // The marker is the fake's signature: a page that reads like prose must
    // never be mistaken for work a model did.
    expect(parsed.lines[0]!.text).toContain(FAKE_MARKER);
  });

  it("answers the term question with terms the passage contains", async () => {
    const report = await extractCandidates({
      units: [unit(1, "Rivendell was quiet that evening"), unit(2, "Rivendell again, at dawn")],
      backend: fakeBackend(),
      sourceLanguage: "en",
      targetLanguage: "it",
    });

    expect(report.abstained).toBe(false);
    // Proposals the book does not contain are discarded by extraction, so a
    // gate with rows is the proof the answer was both readable and honest.
    expect(report.candidates.length).toBeGreaterThan(0);
  });
});
