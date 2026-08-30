import { describe, expect, it } from "vitest";
import { phasesOf } from "../main/projects/phases.ts";
import type { StateRecord } from "../main/run/states.ts";

const phase = (name: string, outcome: StateRecord["outcome"], left: string | null): StateRecord => ({
  kind: "phase", name, outcome, enteredAt: "2026-08-30T09:00:00.000Z", leftAt: left, info: null,
});

const units = { done: 3, total: 10 };

describe("phasesOf", () => {
  it("says five, always, in the order the run walks them", () => {
    expect(phasesOf([], "ready", units).map((p) => p.phase))
      .toEqual(["analyze", "candidates", "code-index", "translate", "compose"]);
  });

  it("a phase nobody has entered is waiting, and has no dates to show", () => {
    const [analyze, candidates] = phasesOf([], "ready", units);
    expect(analyze).toMatchObject({ state: "waiting", startedAt: null, endedAt: null });
    expect(candidates!.state).toBe("waiting");
  });

  it("reads what happened from the record, not from the project's state", () => {
    const history = [
      phase("analyze", "done", "2026-08-30T09:02:00.000Z"),
      phase("candidates", null, null),
    ];
    const [analyze, candidates] = phasesOf(history, "running", units);
    expect(analyze).toMatchObject({ state: "done", endedAt: "2026-08-30T09:02:00.000Z" });
    expect(candidates!.state).toBe("running");
  });

  /*
   * A phase left open by a run that died is not a phase that is running: the
   * project's state is the only thing that knows the difference.
   */
  it("does not call an open phase running when nothing is running", () => {
    const history = [phase("analyze", "done", "x"), phase("translate", null, null)];
    expect(phasesOf(history, "paused", units)[3]!.state).toBe("paused");
    expect(phasesOf(history, "failed", units)[3]!.state).toBe("failed");
  });

  it("carries the phase's own information through", () => {
    const history = [{ ...phase("analyze", "done", "x"), info: { documents: 412 } }];
    expect(phasesOf(history, "ready", units)[0]!.info).toEqual({ documents: 412 });
  });

  it("counts the book on the translation, and nothing on the rest", () => {
    const history = [phase("translate", null, null)];
    const phases = phasesOf(history, "running", units);
    expect(phases[3]).toMatchObject({ done: 3, total: 10 });
    expect(phases[0]!.total).toBeNull();
  });

  it("keeps the last word when a phase ran twice", () => {
    const history = [
      { ...phase("translate", "paused", "2026-08-30T09:10:00.000Z"), info: { attempt: 1 } },
      { ...phase("translate", "done", "2026-08-30T10:00:00.000Z"), info: { attempt: 2 } },
    ];
    expect(phasesOf(history, "done", units)[3]).toMatchObject({
      state: "done", endedAt: "2026-08-30T10:00:00.000Z", info: { attempt: 2 },
    });
  });
});
