import { TestBed } from "@angular/core/testing";
import { describe, expect, it, vi } from "vitest";
import it_IT from "../../../../../locales/it.json";
import type { TermRow } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { provideI18n } from "../../core/i18n";
import { Terms } from "./terms";

const terms: TermRow[] = [
  {
    id: "t1", source: "Rivendell", target: null, rule: "dnt", origin: "extracted",
    approval: "pending", occurrences: 4, sense: null,
    context: "The road to Rivendell was long.", note: null,
  },
  {
    id: "t2", source: "dwarf", target: "nano", rule: "must", origin: "extracted",
    approval: "pending", occurrences: 9, sense: null, context: "the dwarf spoke", note: null,
  },
];

/** A bridge that answers per channel, so a test can script one of them. */
function bridge(answers: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (channel: string, _payload?: unknown) => {
    if (channel in answers) return answers[channel];
    if (channel === "terms.list") return terms;
    if (channel === "glossaries.list") return [];
    return undefined;
  });
}

function mount(invoke = bridge()) {
  TestBed.configureTestingModule({
    imports: [Terms],
    providers: [
      ...provideI18n("it"),
      { provide: IpcService, useValue: { invoke, on: () => () => {} } },
    ],
  });
  const fixture = TestBed.createComponent(Terms);
  fixture.componentRef.setInput("projectId", "p1");
  return { fixture, invoke };
}

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([name]) => name === channel);

describe("Terms", () => {
  it("shows each candidate with the sentence it came from", async () => {
    const { fixture } = mount();
    await fixture.whenStable();

    // A gate that shows only the bare word asks the user to recall a book
    // they may not have read.
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain("Rivendell");
    expect(text).toContain("The road to Rivendell was long.");
  });

  it("sends every decision in one call, not one call per term", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    await fixture.componentInstance.approveAll();

    const decided = calls(invoke, "terms.decide");
    expect(decided).toHaveLength(1);
    expect(decided[0]![1] as { decisions: unknown[] }).toMatchObject({
      decisions: [{ id: "t1" }, { id: "t2" }],
    });
  });

  it("asks for confirmation before a change that invalidates translations", async () => {
    const approved = terms.map((term) => ({ ...term, approval: "approved" as const }));
    const invoke = bridge({
      "terms.list": approved,
      "terms.previewInvalidation": {
        units: ["c1.xhtml#1", "c1.xhtml#3"], cost: { tokensIn: 100, tokensOut: 50 },
      },
    });
    const { fixture } = mount(invoke);
    await fixture.whenStable();

    await fixture.componentInstance.edit("t1", { target: "Forravalle" });
    await fixture.whenStable();
    fixture.detectChanges();

    // The count is on screen, and nothing has been committed yet.
    expect(fixture.nativeElement.textContent as string).toContain("2");
    expect(calls(invoke, "terms.decide")).toHaveLength(0);
    expect(calls(invoke, "terms.invalidate")).toHaveLength(0);
  });

  it("does not ask about invalidation for a term nothing was translated under", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();

    // Both fixtures are pending: editing one cannot undo work that never
    // happened, and asking would be a question with a known answer.
    await fixture.componentInstance.edit("t1", { target: "Forravalle" });

    expect(calls(invoke, "terms.previewInvalidation")).toHaveLength(0);
  });

  it("unblocks the machine only after the decisions are stored", async () => {
    const { fixture, invoke } = mount();
    await fixture.whenStable();
    fixture.componentInstance.decide("t1", "approved");

    await fixture.componentInstance.approveGate();

    const order = invoke.mock.calls.map(([channel]) => channel);
    expect(order.indexOf("terms.decide")).toBeLessThan(order.indexOf("run.approve"));
    expect(calls(invoke, "run.approve")[0]![1]).toMatchObject({ gate: "terms" });
  });

  it("writes no sentence of its own: every label comes from the catalogue", async () => {
    const { fixture } = mount();
    await fixture.whenStable();
    fixture.detectChanges();

    // Compared against the catalogue rather than searched for stray Italian:
    // a label typed into the template would not match, and a missing key
    // would render as the key itself.
    const text = fixture.nativeElement.textContent as string;
    const catalogue = it_IT as unknown as { terms: Record<string, string> };
    expect(text).toContain(catalogue.terms["approveAll"]);
    expect(text).toContain(catalogue.terms["title"]);
    expect(text).not.toContain("terms.");
  });
});
