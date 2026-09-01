import { describe, expect, it } from "vitest";
import { BabelError } from "../../core/errors.ts";
import { classifySystemError } from "../main/failure.ts";

const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe("classifying what the machine answered", () => {
  it("calls a missing file an input problem, and says which", () => {
    const classified = classifySystemError(errno("ENOENT"), { path: "/w/source.epub" });
    expect(classified.code).toBe("SOURCE_MISSING");
    expect(classified.fault).toBe("input");
    expect(classified.detail["path"]).toBe("/w/source.epub");
  });

  /** A full disk is nobody's bug and no retry fixes it: somebody has to act. */
  it("calls a full disk a matter of configuration", () => {
    const classified = classifySystemError(errno("ENOSPC"));
    expect(classified.code).toBe("DISK_FULL");
    expect(classified.fault).toBe("config");
  });

  it.each(["EACCES", "EPERM"])("calls %s a matter of configuration", (code) => {
    expect(classifySystemError(errno(code)).code).toBe("PATH_NOT_WRITABLE");
    expect(classifySystemError(errno(code)).fault).toBe("config");
  });

  it("calls a locked database transient, because it is", () => {
    const classified = classifySystemError(new Error("database is locked"));
    expect(classified.code).toBe("DATABASE_BUSY");
    expect(classified.fault).toBe("transient");
  });

  it("passes one of ours through untouched", () => {
    const mine = new BabelError("x", { code: "GATE_REFUSED", fault: "refused" });
    expect(classifySystemError(mine)).toBe(mine);
  });

  it("calls anything else a defect", () => {
    expect(classifySystemError(new Error("who knows")).fault).toBe("defect");
  });

  /** `Promise.reject()` with no argument rejects with `undefined`: the classifier still owes it a name. */
  it("calls a rejection without a body a defect rather than throwing", () => {
    for (const empty of [null, undefined, "just a string"] as unknown[]) {
      const classified = classifySystemError(empty);
      expect(classified.code).toBe("UNKNOWN");
      expect(classified.fault).toBe("defect");
      expect(classified.cause).toBe(empty);
    }
  });
});
