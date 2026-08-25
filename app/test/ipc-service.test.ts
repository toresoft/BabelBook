import { describe, expect, it, vi } from "vitest";
import { IpcService } from "../renderer/src/app/core/ipc.service.ts";

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

  it("fails loudly when the bridge is missing instead of pretending to work", () => {
    withBridge(undefined);
    expect(() => new IpcService().invoke("settings.get", undefined)).toThrow(/NO_BRIDGE/);
  });
});
