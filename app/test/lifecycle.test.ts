import { describe, expect, it } from "vitest";
import { notifyOn, onQuitRequested, onWindowClose, trayTooltip } from "../main/tray.ts";

describe("lifecycle", () => {
  it("hides the window instead of quitting while a book is being translated", () => {
    expect(onWindowClose(true)).toBe("hide");
  });

  it("quits when there is nothing running", () => {
    expect(onWindowClose(false)).toBe("quit");
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
    expect(notifyOn({ type: "progress", done: 3, total: 100 })).toBeNull();
  });
});

describe("trayTooltip", () => {
  it("builds the tooltip from the catalogue, never from a literal", () => {
    const t = (key: string) => `[${key}]`;
    expect(trayTooltip({ title: "Book", done: 5, total: 10 }, t)).toContain("[tray.translating]");
  });
});
