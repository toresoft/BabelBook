import { describe, expect, it, vi } from "vitest";
import { BabelError } from "../../core/errors.ts";
import { IpcService } from "../renderer/src/app/core/ipc.service.ts";
import { packFailure } from "../shared/dto.ts";

const withBridge = (bridge: unknown) => {
  (globalThis as { window?: unknown }).window = bridge === undefined ? {} : { babelbook: bridge };
};

describe("IpcService", () => {
  it("forwards an invocation to the bridge", async () => {
    const invoke = vi.fn().mockResolvedValue({ path: "/books/one.epub", name: "one.epub" });
    withBridge({ invoke, on: vi.fn() });

    await expect(new IpcService().invoke("project.chooseEpub", undefined))
      .resolves.toEqual({ path: "/books/one.epub", name: "one.epub" });
    expect(invoke).toHaveBeenCalledWith("project.chooseEpub", undefined);
  });

  it("hands back the unsubscribe an event subscription returns", () => {
    const off = vi.fn();
    withBridge({ invoke: vi.fn(), on: vi.fn().mockReturnValue(off) });

    new IpcService().on("project.changed", () => {})();
    expect(off).toHaveBeenCalled();
  });

  it("fails loudly when the bridge is missing instead of pretending to work", async () => {
    withBridge(undefined);

    // An invocation rejects; a subscription throws where it is called. Either
    // way the fault names itself once, instead of becoming a screen that
    // renders nothing and explains nothing.
    await expect(new IpcService().invoke("settings.get", undefined)).rejects.toThrow(/NO_BRIDGE/);
    expect(() => new IpcService().on("project.changed", () => {})).toThrow(/NO_BRIDGE/);
  });
});

describe("failures crossing the boundary", () => {
  it("hands the caller a code, not a sentence", async () => {
    const packed = new Error(packFailure(
      new BabelError("UNSUPPORTED_FORMAT: MOBI", {
        code: "UNSUPPORTED_FORMAT", fault: "input", detail: { format: "MOBI" },
      }),
    ));
    withBridge({ invoke: vi.fn().mockRejectedValue(packed), on: vi.fn() });

    await expect(new IpcService().invoke("settings.get", undefined))
      .rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", format: "MOBI", fault: "input" });
  });

  it("says UNKNOWN rather than inventing a code it did not receive", async () => {
    withBridge({ invoke: vi.fn().mockRejectedValue(new Error("something went wrong")), on: vi.fn() });

    await expect(new IpcService().invoke("settings.get", undefined))
      .rejects.toMatchObject({ code: "UNKNOWN" });
  });
});
