import { describe, expect, it } from "vitest";
import { notifyOn, onQuitRequested, onWindowClose, tooltipFor } from "../main/tray.ts";

describe("lifecycle", () => {
  it("hides the window instead of quitting while a book is being translated", () => {
    expect(onWindowClose(true, true)).toBe("hide");
  });

  it("quits when there is nothing running", () => {
    expect(onWindowClose(false, true)).toBe("quit");
  });

  // Production break: the window vanishes, the process lives on, and the only
  // way back is a kill from a terminal.
  it("quits rather than hiding when there is no tray to come back from", () => {
    expect(onWindowClose(true, false)).toBe("quit");
  });

  it("asks for confirmation before quitting with work in flight", () => {
    expect(onQuitRequested(true)).toBe("confirm");
  });
});

describe("notifications", () => {
  it("notifies when a book is finished", () => {
    expect(notifyOn({ type: "done", summary: {} as never })?.key).toBe("notify.done");
  });

  it("notifies when a gate is waiting for the user", () => {
    expect(notifyOn({ type: "gate", gate: "terms" })?.key).toBe("notify.gate.terms");
  });

  it("says nothing about ordinary progress", () => {
    expect(notifyOn({ type: "progress", phase: "translate", done: 3, total: 100 })).toBeNull();
  });
});

describe("tooltipFor", () => {
  const t = (key: string, params?: unknown) =>
    `[${key}]${params === undefined ? "" : " " + JSON.stringify(params)}`;

  it("counts the book while it is being translated", () => {
    const said = tooltipFor(
      { type: "progress", phase: "translate", done: 5, total: 10 }, "Book", t);
    expect(said).toContain("[tray.translating]");
    expect(said).toContain("Book");
  });

  /*
   * Production break: the tray went on saying "5 of 10" after the run had
   * stopped at a gate or died, which is a claim about work that is not
   * happening — and the tooltip is all a hidden window still says.
   */
  it("stops counting when the run stops", () => {
    expect(tooltipFor({ type: "gate", gate: "terms" }, "Book", t)).toContain("[tray.waiting]");
    expect(tooltipFor({ type: "failed", code: "boom" }, "Book", t)).toBe("[tray.idle]");
    expect(tooltipFor({ type: "done", summary: {} as never }, "Book", t)).toBe("[tray.idle]");
  });

  it("leaves the tooltip alone for everything else", () => {
    expect(tooltipFor({ type: "phase", phase: "translate" }, "Book", t)).toBeNull();
    expect(tooltipFor({ type: "usage", tokensIn: 1, tokensOut: 2, reasoningTokens: 0 }, "Book", t))
      .toBeNull();
  });

  it("says nothing about a book it cannot name, except that there is none", () => {
    expect(tooltipFor({ type: "progress", phase: "translate", done: 1, total: 2 }, null, t))
      .toBeNull();
    expect(tooltipFor({ type: "done", summary: {} as never }, null, t)).toBe("[tray.idle]");
  });
});
